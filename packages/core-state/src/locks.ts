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
 * Contention (Req 12.4): when a path/branch already has an active winning lock
 * held by another member, a new acquisition is recorded as a **concurrent
 * claim** (`concurrent: true`) and the existing winner is returned so the caller
 * can report the winning holder and its Event_Revision. The winner is the active
 * non-concurrent lock for the group; on release of the winner the earliest
 * remaining claim (lowest Event_Revision) is promoted so the group never lacks a
 * winner while claims exist.
 *
 * Holder checks on release: a release by a member who does not hold the winning
 * lock is rejected with `NOT_LOCK_HOLDER` and the lock is retained unchanged
 * (Req 12.7); a release for a path/branch with no active lock is rejected with
 * `NO_ACTIVE_LOCK` (Req 12.8).
 */

import type { Lock, MemberRef, RiskLevel, ScopeKind, SessionId } from "@cfls/protocol";

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
   * The active winning lock for the target scope/branch. Equals {@link lock}
   * when the acquisition won uncontended; otherwise the pre-existing holder
   * whose identity and Event_Revision the caller should report (Req 12.4).
   */
  winner: Lock;
  /** True when the acquisition was recorded as a concurrent (losing) claim. */
  contended: boolean;
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
   * Acquire a lock (Req 12.1–12.4). Records the lock verbatim with the supplied
   * Event_Revision. If the target scope/branch has no active lock, the new lock
   * wins uncontended. If another member already holds the winning lock, the new
   * lock is recorded as a concurrent claim and the existing winner is returned
   * (Req 12.4). A re-acquisition by the current winner is idempotent.
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

    const currentWinner = claims.find((lock) => !lock.concurrent);

    // The current winner re-acquiring its own lock: no new claim, return as-is.
    if (
      currentWinner !== undefined &&
      currentWinner.holder.memberId === request.holder.memberId
    ) {
      return { lock: currentWinner, winner: currentWinner, contended: false };
    }

    const contended = currentWinner !== undefined;
    const lock: Lock = {
      lockId: request.lockId,
      scope: request.scope,
      scopeKind: request.scopeKind,
      mode: request.mode,
      holder: request.holder,
      branch: request.branch,
      eventRevision: request.eventRevision,
      acquiredAt: request.acquiredAt,
      concurrent: contended,
    };

    claims.push(lock);
    groups.set(gKey, claims);

    return {
      lock,
      winner: contended ? (currentWinner as Lock) : lock,
      contended,
    };
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

    const winner = claims.find((lock) => !lock.concurrent);
    if (winner === undefined) {
      return { ok: false, code: "NO_ACTIVE_LOCK" };
    }

    if (winner.holder.memberId !== request.requester.memberId) {
      // Non-holder release: retain the lock unchanged (Req 12.7).
      return { ok: false, code: "NOT_LOCK_HOLDER" };
    }

    // Remove the winning lock.
    const remaining = claims.filter((lock) => lock.lockId !== winner.lockId);

    let promoted: Lock | undefined;
    if (remaining.length > 0) {
      // Promote the earliest remaining claim (lowest Event_Revision) so the
      // group never lacks a winner while claims exist.
      const earliest = remaining.reduce((best, lock) =>
        lock.eventRevision < best.eventRevision ? lock : best,
      );
      promoted = { ...earliest, concurrent: false };
      const promotedClaims = remaining.map((lock) =>
        lock.lockId === earliest.lockId ? (promoted as Lock) : lock,
      );
      groups.set(gKey, promotedClaims);
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
