/**
 * Lock registry — acquire/release of soft, coordination-required, and hard locks
 * (Req 12.1–12.8, 13.1–13.5, 14.1–14.4; design §10.3, §10.4).
 *
 * The {@link LockRegistry} is the pure, in-memory authority for coordination
 * locks. It is dependency-free (no I/O, no clocks): callers assign the
 * authoritative `eventRevision` (from the host's monotonic counter, task 4.4)
 * and the `acquiredAt` timestamp, and the registry records them verbatim. This
 * keeps ordering and conflict resolution driven exclusively by the per-session
 * Event_Revision total order, never raw client time.
 *
 * State is isolated per `Repository_Session` (keyed by the opaque
 * {@link sessionKey}) so unrelated repos/teams/branches never mix (Req 10.2).
 * Within a session, locks are grouped by `(scopeKey, branch)`: two locks contend
 * only when they target the same normalized scope **under the same
 * Branch_Context** (Req 12.4). Cross-branch locks on the same path never contend.
 *
 * Each recorded {@link Lock} captures everything Req 12.3 mandates: the holding
 * Team_Member identity and originating device (via {@link MemberRef}), the
 * repository-relative path or Intent_Scope, the Branch_Context, the assigning
 * Event_Revision, and `acquiredAt`. All three modes — `soft`,
 * `coordination-required`, and `hard` — are recorded identically here; the
 * differing *enforcement* semantics (override/audit §10.3, hard-stop §10.4) are
 * layered on top by consumers reading this registry.
 *
 * Contention (Req 12.4, 8.2, 14.5): when a path/branch has more than one claim,
 * the winner is resolved through the shared {@link resolveByEarliestRevision}
 * resolver as the claim with the **earliest assigned Event_Revision** — never a
 * raw timestamp (Req 8.3). This is *order-independent*: a claim that is recorded
 * later but carries an earlier revision still wins, and the previously-winning
 * claim is demoted to a concurrent claim. Every non-winning claim is recorded
 * with `concurrent: true`; the acquisition outcome reports the winning holder,
 * its Event_Revision, and (for a losing acquisition) the {@link ConflictInfo}
 * naming that winner (Req 8.4, 12.4). On release of the winner the earliest
 * remaining claim is promoted so the group never lacks a winner while claims
 * exist.
 *
 * Holder checks on release: a release by a member who does not hold the winning
 * lock is rejected with `NOT_LOCK_HOLDER` and the lock is retained unchanged
 * (Req 12.7); a release for a path/branch with no active lock is rejected with
 * `NO_ACTIVE_LOCK` (Req 12.8).
 */

import type {
  Lock,
  MemberRef,
  RiskLevel,
  ScopeKind,
  SessionId,
} from "@cfls/protocol";

import { type ConflictInfo, resolveByEarliestRevision } from "./conflict";
import { normalizePathKey, type PlatformCaseSensitivity } from "./path";
import { sessionKey } from "./session";

/** A request to acquire a lock; `eventRevision`/`acquiredAt` are assigned by the caller. */
export interface LockAcquisition {
  session: SessionId;
  /** Opaque lock identifier (assigned upstream, e.g. from the Event_ID). */
  lockId: string;
  /** Repository-relative path, folder, or glob (<=4096 chars per Req 12.3). */
  scope: string;
  scopeKind: ScopeKind;
  mode: RiskLevel;
  holder: MemberRef;
  /** Branch_Context under which the lock is held. */
  branch: string;
  /** Authoritative Event_Revision assigned by the host (Req 12.2). */
  eventRevision: number;
  /** ISO-8601 acquisition time (recorded verbatim; never used as a resolver). */
  acquiredAt: string;
}

/** A release request identifying the target by lockId or by scope, plus the requester. */
export interface LockRelease {
  session: SessionId;
  requester: MemberRef;
  branch: string;
  /** Release by explicit lock id (preferred), or by `scope` when absent. */
  lockId?: string;
  /** Release by scope when `lockId` is absent (Req 12.5). */
  scope?: string;
}

/** Outcome of an acquisition: the recorded lock and the current winning lock for its group. */
export interface AcquireOutcome {
  /** The lock that was recorded (its `concurrent` flag reflects whether it won). */
  lock: Lock;
  /**
   * The winning lock for the target scope/branch — the claim with the earliest
   * Event_Revision (Req 8.2, 12.4, 14.5). Equals {@link lock} when the
   * acquisition won; otherwise the claim whose holder identity and
   * Event_Revision the caller should report.
   */
  winner: Lock;
  /** True when the acquisition was recorded as a concurrent (losing) claim. */
  contended: boolean;
  /**
   * Present only when {@link contended} — the winning member + revision to
   * report to the losing claimant (Req 8.4, 12.4).
   */
  conflict?: ConflictInfo;
}

/** Error codes surfaced by {@link LockRegistry.release} (design §11.1). */
export type LockReleaseError = "NOT_LOCK_HOLDER" | "NO_ACTIVE_LOCK";

/** Result of a release attempt. */
export type ReleaseResult =
  | {
      ok: true;
      /** The removed winning lock. */
      released: Lock;
      /** The claim promoted to winner in its place, if any remained. */
      promoted?: Lock;
    }
  | { ok: false; code: LockReleaseError };

/** Internal per-session grouping key for a `(scope, branch)` pair. */
function groupKey(
  scope: string,
  scopeKind: ScopeKind,
  branch: string,
  sensitivity: PlatformCaseSensitivity | undefined,
): string {
  // Globs are matched verbatim; file/folder scopes are path-normalized so
  // equivalent spellings collapse to one key (Req 10.3–10.4).
  const scopePart =
    scopeKind === "glob"
      ? `glob:${scope}`
      : `path:${normalizePathKey(scope, sensitivity)}`;
  return `${branch}\u0000${scopePart}`;
}

/**
 * Pure in-memory registry of coordination locks (Req 12, 13, 14; §10.3, §10.4).
 */
export class LockRegistry {
  /** `session_key` → (`groupKey` → claims for that scope/branch). */
  private readonly sessions = new Map<string, Map<string, Lock[]>>();

  /**
   * Optional platform case-sensitivity used to normalize file/folder scopes.
   * When omitted, {@link normalizePathKey}'s platform default applies.
   */
  constructor(private readonly sensitivity?: PlatformCaseSensitivity) {}

  private groupsFor(session: SessionId): Map<string, Lock[]> {
    const key = sessionKey(session);
    let groups = this.sessions.get(key);
    if (groups === undefined) {
      groups = new Map<string, Lock[]>();
      this.sessions.set(key, groups);
    }
    return groups;
  }

  /**
   * Resolve a group's claims through the shared earliest-Event_Revision resolver
   * (§10.2), mutating each stored {@link Lock}'s `concurrent` flag in place so
   * the winner is the earliest-revision claim regardless of insertion order
   * (Req 8.2, 12.4, 14.5). Returns the winning lock, or `undefined` when empty.
   */
  private resolveGroup(claims: readonly Lock[]): Lock | undefined {
    if (claims.length === 0) {
      return undefined;
    }
    const wrapped = claims.map((lock) => ({
      claimId: lock.lockId,
      eventRevision: lock.eventRevision,
      holder: lock.holder,
      lock,
    }));
    const { winner, resolved } = resolveByEarliestRevision(wrapped);
    for (const entry of resolved) {
      entry.claim.lock.concurrent = entry.concurrent;
    }
    return winner?.lock;
  }

  /**
   * Acquire a lock (Req 12.1–12.4, 8.2). Records the lock verbatim with the
   * supplied Event_Revision, then resolves the target scope/branch group through
   * the shared resolver so the winner is the claim with the earliest
   * Event_Revision — independent of the order in which claims arrive (Req 8.2,
   * 14.5). Losing claims are recorded as concurrent (Req 8.4, 12.4). A
   * re-acquisition by a member that already holds a claim in the group is
   * idempotent (no new claim recorded).
   */
  acquire(request: LockAcquisition): AcquireOutcome {
    const groups = this.groupsFor(request.session);
    const gKey = groupKey(
      request.scope,
      request.scopeKind,
      request.branch,
      this.sensitivity,
    );
    const claims = groups.get(gKey) ?? [];

    // Idempotency: a member that already has a claim in this group does not add
    // a second one; return its existing claim after re-resolving the winner.
    const existing = claims.find(
      (lock) => lock.holder.memberId === request.holder.memberId,
    );
    if (existing !== undefined) {
      const winner = this.resolveGroup(claims) as Lock;
      return this.outcome(existing, winner);
    }

    const lock: Lock = {
      lockId: request.lockId,
      scope: request.scope,
      scopeKind: request.scopeKind,
      mode: request.mode,
      holder: request.holder,
      branch: request.branch,
      eventRevision: request.eventRevision,
      acquiredAt: request.acquiredAt,
      concurrent: false,
    };

    claims.push(lock);
    groups.set(gKey, claims);

    const winner = this.resolveGroup(claims) as Lock;
    return this.outcome(lock, winner);
  }

  /** Build an {@link AcquireOutcome} for a recorded lock and its group winner. */
  private outcome(lock: Lock, winner: Lock): AcquireOutcome {
    const contended = lock.lockId !== winner.lockId;
    return contended
      ? {
          lock,
          winner,
          contended: true,
          conflict: {
            winner: winner.holder,
            winningEventRevision: winner.eventRevision,
          },
        }
      : { lock, winner, contended: false };
  }

  /**
   * Release a lock (Req 12.5–12.8). The target group is located by `lockId`
   * (preferred) or by `scope`. Rejects with `NO_ACTIVE_LOCK` when no active lock
   * exists (Req 12.8), and with `NOT_LOCK_HOLDER` — retaining the lock unchanged
   * — when the requester does not hold the winning lock (Req 12.7). On success
   * the winning lock is removed and the earliest remaining concurrent claim is
   * promoted to winner.
   */
  release(request: LockRelease): ReleaseResult {
    const groups = this.groupsFor(request.session);

    let gKey: string | undefined;
    let claims: Lock[] | undefined;

    if (request.lockId !== undefined) {
      for (const [candidateKey, candidateClaims] of groups) {
        if (candidateClaims.some((lock) => lock.lockId === request.lockId)) {
          gKey = candidateKey;
          claims = candidateClaims;
          break;
        }
      }
    } else if (request.scope !== undefined) {
      // Scope-based release must resolve a scopeKind; infer from an existing
      // claim so file/folder/glob normalization matches how it was stored.
      for (const [candidateKey, candidateClaims] of groups) {
        const sample = candidateClaims[0];
        if (sample === undefined) {
          continue;
        }
        const candidate = groupKey(
          request.scope,
          sample.scopeKind,
          request.branch,
          this.sensitivity,
        );
        if (candidate === candidateKey) {
          gKey = candidateKey;
          claims = candidateClaims;
          break;
        }
      }
    }

    if (gKey === undefined || claims === undefined || claims.length === 0) {
      return { ok: false, code: "NO_ACTIVE_LOCK" };
    }

    // Resolve the current winner by earliest Event_Revision (Req 8.2), keeping
    // stored concurrent flags in sync before the holder check.
    const winner = this.resolveGroup(claims);
    if (winner === undefined) {
      return { ok: false, code: "NO_ACTIVE_LOCK" };
    }

    if (winner.holder.memberId !== request.requester.memberId) {
      // Non-holder release: retain the lock unchanged (Req 12.7).
      return { ok: false, code: "NOT_LOCK_HOLDER" };
    }

    // Remove the winning lock and re-resolve so the earliest remaining claim is
    // promoted (Req 8.2) — the group never lacks a winner while claims exist.
    const remaining = claims.filter((lock) => lock.lockId !== winner.lockId);

    let promoted: Lock | undefined;
    if (remaining.length > 0) {
      promoted = this.resolveGroup(remaining);
      groups.set(gKey, remaining);
    } else {
      groups.delete(gKey);
    }

    return promoted === undefined
      ? { ok: true, released: winner }
      : { ok: true, released: winner, promoted };
  }

  /**
   * The active winning lock for a scope/branch, or `undefined` when none exists.
   * Used by hard-stop enforcement (§10.4) and coordination-required checks
   * (§10.3) to identify the single holder all cooperating tools enforce against.
   */
  winningLock(
    session: SessionId,
    scope: string,
    scopeKind: ScopeKind,
    branch: string,
  ): Lock | undefined {
    const groups = this.sessions.get(sessionKey(session));
    if (groups === undefined) {
      return undefined;
    }
    const claims = groups.get(
      groupKey(scope, scopeKind, branch, this.sensitivity),
    );
    return claims?.find((lock) => !lock.concurrent);
  }

  /**
   * Transfer a member's active lock from `fromScope` to `toScope` under the same
   * Branch_Context following a confirmed rename/move (Req 30.2). Only a lock held
   * by `member` (winning or concurrent) is moved; the holding Team_Member
   * identity is retained and the change is stamped with the caller-assigned
   * `eventRevision`. The `(scope, branch)` grouping is recomputed on both the
   * source and destination groups so winners stay correct (Req 8.2). Returns the
   * transferred lock, or `undefined` when the member held no lock on `fromScope`
   * (Req 30.7 — the caller then only updates its tracked path set).
   */
  transferPath(request: {
    session: SessionId;
    member: MemberRef;
    fromScope: string;
    toScope: string;
    scopeKind: ScopeKind;
    branch: string;
    eventRevision: number;
  }): Lock | undefined {
    const groups = this.groupsFor(request.session);
    const fromKey = groupKey(
      request.fromScope,
      request.scopeKind,
      request.branch,
      this.sensitivity,
    );
    const claims = groups.get(fromKey);
    if (claims === undefined) {
      return undefined;
    }
    const heldIndex = claims.findIndex(
      (lock) => lock.holder.memberId === request.member.memberId,
    );
    if (heldIndex === -1) {
      return undefined;
    }

    // Remove the member's claim from the source group and re-resolve it.
    const [held] = claims.splice(heldIndex, 1);
    if (claims.length === 0) {
      groups.delete(fromKey);
    } else {
      this.resolveGroup(claims);
      groups.set(fromKey, claims);
    }

    // Record the transferred lock under the destination scope with the new
    // revision, retaining the holder identity and acquisition time (Req 30.2).
    const moved: Lock = {
      ...(held as Lock),
      scope: request.toScope,
      eventRevision: request.eventRevision,
      concurrent: false,
    };
    const toKey = groupKey(
      request.toScope,
      request.scopeKind,
      request.branch,
      this.sensitivity,
    );
    const destClaims = groups.get(toKey) ?? [];
    destClaims.push(moved);
    this.resolveGroup(destClaims);
    groups.set(toKey, destClaims);

    return moved;
  }

  /**
   * Release a member's active lock on `scope` following a confirmed deletion
   * (Req 30.5). Only a lock held by `member` is removed; other members' claims on
   * the same scope are left intact and the group is re-resolved so the earliest
   * remaining claim is promoted (Req 8.2). Returns the removed lock, or
   * `undefined` when the member held no lock on the path (Req 30.7).
   */
  releaseOnDelete(
    session: SessionId,
    scope: string,
    scopeKind: ScopeKind,
    branch: string,
    member: MemberRef,
  ): Lock | undefined {
    const groups = this.groupsFor(session);
    const gKey = groupKey(scope, scopeKind, branch, this.sensitivity);
    const claims = groups.get(gKey);
    if (claims === undefined) {
      return undefined;
    }
    const heldIndex = claims.findIndex(
      (lock) => lock.holder.memberId === member.memberId,
    );
    if (heldIndex === -1) {
      return undefined;
    }
    const [removed] = claims.splice(heldIndex, 1);
    if (claims.length === 0) {
      groups.delete(gKey);
    } else {
      this.resolveGroup(claims);
      groups.set(gKey, claims);
    }
    return removed as Lock;
  }

  /** All claims (winning and concurrent) recorded for a scope/branch. */
  claimsForScope(
    session: SessionId,
    scope: string,
    scopeKind: ScopeKind,
    branch: string,
  ): readonly Lock[] {
    const groups = this.sessions.get(sessionKey(session));
    if (groups === undefined) {
      return [];
    }
    return (
      groups.get(groupKey(scope, scopeKind, branch, this.sensitivity)) ?? []
    ).slice();
  }

  /**
   * Release every lock (winning and concurrent) whose holder acted from
   * `deviceId`, across all scope/branch groups in the session — the stale-lock
   * expiry primitive (Req 26.3). Locks held by any other device are left
   * untouched, and each group with survivors is re-resolved so the earliest
   * remaining claim is promoted to winner (Req 8.2). Returns the removed locks
   * (in stable per-group order) so the caller can emit removal events (Req 26.4);
   * an empty array means the device held nothing.
   */
  expireByDevice(session: SessionId, deviceId: string): Lock[] {
    const groups = this.sessions.get(sessionKey(session));
    if (groups === undefined) {
      return [];
    }

    const removed: Lock[] = [];
    for (const [gKey, claims] of [...groups]) {
      const survivors: Lock[] = [];
      for (const lock of claims) {
        if (lock.holder.deviceId === deviceId) {
          removed.push(lock);
        } else {
          survivors.push(lock);
        }
      }
      if (survivors.length === claims.length) {
        // Nothing removed from this group; leave it (and its winner) intact.
        continue;
      }
      if (survivors.length === 0) {
        groups.delete(gKey);
      } else {
        // Re-resolve so the earliest remaining claim is promoted (Req 8.2).
        this.resolveGroup(survivors);
        groups.set(gKey, survivors);
      }
    }
    return removed;
  }

  /**
   * Replace a session's entire lock state with a persisted set of locks
   * (authoritative-state restore after a host restart or a sync-snapshot
   * replacement — Req 1.5, 1.6, 9.5). Existing state for the session is
   * discarded, each lock is re-grouped by its `(scope, branch)`, and every group
   * is re-resolved so the earliest-Event_Revision claim is the winner (Req 8.2)
   * — the restored winners match what the live registry would have computed,
   * independent of the order locks appear in the snapshot. Locks are deep-copied
   * so the registry never aliases the caller's snapshot objects.
   */
  restore(session: SessionId, locks: readonly Lock[]): void {
    const groups = new Map<string, Lock[]>();
    this.sessions.set(sessionKey(session), groups);
    for (const lock of locks) {
      const gKey = groupKey(
        lock.scope,
        lock.scopeKind,
        lock.branch,
        this.sensitivity,
      );
      const claims = groups.get(gKey) ?? [];
      claims.push({ ...lock, holder: { ...lock.holder } });
      groups.set(gKey, claims);
    }
    for (const claims of groups.values()) {
      this.resolveGroup(claims);
    }
  }

  /**
   * Release every **soft-mode** lock whose acquisition time is strictly older
   * than `cutoffMs` (epoch ms), across all scope/branch groups in the session —
   * the Soft_Lock maximum-age expiry primitive (Req 26.5). Coordination-required
   * and hard locks are never removed here, and soft locks with an unparseable
   * `acquiredAt` are left intact. Each group with survivors is re-resolved so the
   * earliest remaining claim is promoted to winner (Req 8.2). Returns the removed
   * locks (in stable per-group order) so the caller can emit removal events; an
   * empty array means nothing aged out.
   */
  expireSoftLocksAcquiredBefore(session: SessionId, cutoffMs: number): Lock[] {
    const groups = this.sessions.get(sessionKey(session));
    if (groups === undefined) {
      return [];
    }

    const removed: Lock[] = [];
    for (const [gKey, claims] of [...groups]) {
      const survivors: Lock[] = [];
      for (const lock of claims) {
        const acquiredMs = Date.parse(lock.acquiredAt);
        if (
          lock.mode === "soft" &&
          Number.isFinite(acquiredMs) &&
          acquiredMs < cutoffMs
        ) {
          removed.push(lock);
        } else {
          survivors.push(lock);
        }
      }
      if (survivors.length === claims.length) {
        // Nothing removed from this group; leave it (and its winner) intact.
        continue;
      }
      if (survivors.length === 0) {
        groups.delete(gKey);
      } else {
        // Re-resolve so the earliest remaining claim is promoted (Req 8.2).
        this.resolveGroup(survivors);
        groups.set(gKey, survivors);
      }
    }
    return removed;
  }

  /** Every lock recorded for a session (winning and concurrent). */
  allLocks(session: SessionId): readonly Lock[] {
    const groups = this.sessions.get(sessionKey(session));
    if (groups === undefined) {
      return [];
    }
    const all: Lock[] = [];
    for (const claims of groups.values()) {
      all.push(...claims);
    }
    return all;
  }
}
