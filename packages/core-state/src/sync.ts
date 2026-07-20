/**
 * Reconnect-safe sync-from-revision convergence (Req 9.1–9.6, 33.4, 33.5;
 * design §4.6).
 *
 * When a CoordinationAgent loses and later re-establishes its connection it must
 * converge its locally cached coordination state back to the CoordinationHost's
 * authoritative state **without missing or re-applying any event** (design §4.6,
 * Property 8). This module is the pure, dependency-free engine that both sides
 * embed:
 *
 *   1. The agent records the highest Event_Revision it has applied per
 *      `Repository_Session` (Req 9.1) — {@link AgentSyncCache.highestApplied}.
 *   2. On reconnect it asks the host to sync from that revision (Req 9.2).
 *   3. The host serves an **incremental** {@link SyncResponse} of the
 *      coordination events with a *greater* Event_Revision (Req 9.3), or — when
 *      it can no longer serve incrementally (its retained log has been compacted
 *      past the requested revision) — a **full snapshot** the agent replaces its
 *      cached state with (Req 9.5). {@link CoordinationEventLog.syncFrom}
 *      realizes this decision.
 *   4. The agent applies the response, converging its cache to the authoritative
 *      state (Req 9.4/33.4), and clears its staleness marker on completion
 *      (Req 6.6/33.5) — {@link AgentSyncCache.applySync}.
 *
 * ## Cached-state model
 *
 * The agent's cached coordination state is modeled as the **set of active
 * coordination entries** the host broadcasts — exactly the
 * {@link CoordinationUpdate}s of design §4.3. Each entry is identified by a
 * stable {@link coordinationEntryKey} of `(entryType, path, member)`; an
 * `op: "added"` update installs (or replaces) that entry and an `op: "removed"`
 * update deletes it. Replaying a session's ordered update log from empty
 * therefore reproduces the host's authoritative entry set, and a
 * {@link SessionStateSnapshot} projects to the *same* entry set via
 * {@link projectSnapshot}. This is what makes incremental sync and snapshot
 * fallback interchangeable: both converge the agent to one well-defined state.
 *
 * The module holds no clocks and performs no I/O: revisions are assigned
 * upstream by the host counter (task 4.4) and callers own the transport.
 */

import type {
  CoordinationUpdate,
  MemberRef,
  SessionId,
  SessionStateSnapshot,
} from "@cfls/protocol";

import { normalizePath } from "./path";
import { sessionKey } from "./session";

/**
 * The host's answer to a `sync.request {fromRevision}` (design §4.6):
 * either the incremental `sync.events` for revisions `> fromRevision`
 * (Req 9.3), or the full `sync.snapshot` fallback the agent replaces its cached
 * state with when incremental service is impossible (Req 9.5).
 */
export type SyncResponse =
  | { kind: "events"; events: CoordinationUpdate[] }
  | { kind: "snapshot"; snapshot: SessionStateSnapshot };

/**
 * A stable identity for a coordination entry, so an `added`/`removed` pair for
 * the "same thing" collapses to one cache slot. Two updates address the same
 * entry when they share `entryType`, normalized `path`, and holder `memberId`.
 * Paths are normalized so equivalent spellings map to one key (Req 10.3–10.4);
 * a path-less entry (e.g. an intent with no single path) keys on the empty path.
 */
export function coordinationEntryKey(update: {
  entryType: CoordinationUpdate["entryType"];
  path?: string;
  member: MemberRef;
}): string {
  const pathKey = update.path === undefined ? "" : normalizePath(update.path);
  return `${update.entryType}\u0000${pathKey}\u0000${update.member.memberId}`;
}

/**
 * Project an authoritative {@link SessionStateSnapshot} into the canonical set
 * of active coordination entries (design §4.3/§4.6). This is the single
 * definition of "what the agent's cache should contain" for a session, so
 * applying a snapshot (Req 9.5) converges the agent to the very same entry set
 * that replaying the session's full update log would.
 *
 * The projection mirrors what the host broadcasts as `added` updates:
 *   - every recorded lock → a `soft_lock` entry at its scope, held by its holder;
 *   - every **active** presence (`started`/`editing`; `stopped` is end-of-presence
 *     and therefore absent) → a `presence` entry;
 *   - every Declared_Intent → an `intent` entry per `modifyPaths` path and a
 *     `planned_file_creation` entry per `createPaths` path, owned by the member.
 *
 * Each entry carries the source entity's Event_Revision. Returned entries are
 * independent copies; the snapshot is not mutated.
 */
export function projectSnapshot(
  snapshot: SessionStateSnapshot,
): CoordinationUpdate[] {
  const entries: CoordinationUpdate[] = [];

  for (const lock of snapshot.locks) {
    entries.push({
      entryType: "soft_lock",
      op: "added",
      path: lock.scope,
      member: { ...lock.holder },
      eventRevision: lock.eventRevision,
    });
  }

  for (const presence of snapshot.presence) {
    if (presence.state === "stopped") {
      continue;
    }
    entries.push({
      entryType: "presence",
      op: "added",
      path: presence.path,
      member: { ...presence.member },
      eventRevision: presence.eventRevision,
    });
  }

  for (const intent of snapshot.intents) {
    for (const path of intent.modifyPaths) {
      entries.push({
        entryType: "intent",
        op: "added",
        path,
        member: { ...intent.owner },
        eventRevision: intent.eventRevision,
      });
    }
    for (const creation of intent.createPaths) {
      entries.push({
        entryType: "planned_file_creation",
        op: "added",
        path: creation.path,
        member: { ...intent.owner },
        eventRevision: intent.eventRevision,
      });
    }
  }

  return entries;
}

/**
 * Host-side append-only log of broadcast {@link CoordinationUpdate}s per
 * `Repository_Session`, and the source of the reconnect {@link SyncResponse}
 * (Req 9.3, 9.5; design §4.6).
 *
 * Every accepted coordination event is {@link append}ed in strictly increasing
 * Event_Revision order. {@link syncFrom} then serves the suffix `> fromRevision`
 * incrementally, unless the log has been compacted past the requested revision —
 * in which case it falls back to the caller-supplied authoritative snapshot so
 * the agent still converges (Req 9.5).
 *
 * Pure in-memory state: the host `Store` (task 8.4) owns durability; this class
 * is the ordering/serviceability logic reused by {@link syncFrom}.
 */
export class CoordinationEventLog {
  /** `session_key` → updates in strictly increasing Event_Revision order. */
  private readonly logs = new Map<string, CoordinationUpdate[]>();

  /**
   * `session_key` → highest revision discarded by compaction (0 ⇒ nothing
   * discarded). An incremental sync is serviceable only from a revision at or
   * above this watermark, since everything strictly greater is still retained.
   */
  private readonly compactedThrough = new Map<string, number>();

  /**
   * Append an accepted coordination update to a session's log (design §4.5).
   * Updates must arrive in strictly increasing Event_Revision order — the host
   * counter guarantees this — so the log is always sorted and gap-free above the
   * compaction watermark.
   *
   * @throws if `eventRevision` is not a positive integer, or is not strictly
   *   greater than the last appended revision for the session.
   */
  append(session: SessionId, update: CoordinationUpdate): void {
    if (!Number.isInteger(update.eventRevision) || update.eventRevision <= 0) {
      throw new RangeError(
        `eventRevision must be a positive integer, got ${update.eventRevision}.`,
      );
    }
    const key = sessionKey(session);
    const log = this.logs.get(key) ?? [];
    const last = log[log.length - 1];
    if (last !== undefined && update.eventRevision <= last.eventRevision) {
      throw new RangeError(
        `eventRevision ${update.eventRevision} must exceed the last appended ` +
          `revision ${last.eventRevision} for the session.`,
      );
    }
    log.push({ ...update, member: { ...update.member } });
    this.logs.set(key, log);
  }

  /**
   * Discard every retained update with `eventRevision <= throughRevision`,
   * simulating log compaction/retention (design §4.6). After this, a
   * {@link syncFrom} request whose `fromRevision` is below `throughRevision` can
   * no longer be served incrementally and falls back to a snapshot (Req 9.5).
   * The watermark only ever advances.
   */
  compact(session: SessionId, throughRevision: number): void {
    if (!Number.isInteger(throughRevision) || throughRevision < 0) {
      throw new RangeError(
        `throughRevision must be a non-negative integer, got ${throughRevision}.`,
      );
    }
    const key = sessionKey(session);
    const existing = this.compactedThrough.get(key) ?? 0;
    const watermark = Math.max(existing, throughRevision);
    this.compactedThrough.set(key, watermark);
    const log = this.logs.get(key);
    if (log !== undefined) {
      this.logs.set(
        key,
        log.filter((update) => update.eventRevision > watermark),
      );
    }
  }

  /** The highest Event_Revision appended for a session (0 if none). */
  highestRevision(session: SessionId): number {
    const log = this.logs.get(sessionKey(session));
    const last = log?.[log.length - 1];
    return last?.eventRevision ?? 0;
  }

  /** Whether an incremental sync from `fromRevision` can be served (Req 9.3). */
  canServeIncrementally(session: SessionId, fromRevision: number): boolean {
    if (!Number.isInteger(fromRevision) || fromRevision < 0) {
      return false;
    }
    return (
      fromRevision >= (this.compactedThrough.get(sessionKey(session)) ?? 0)
    );
  }

  /**
   * Serve a reconnect sync request for `fromRevision` (Req 9.2–9.5; design §4.6).
   *
   * Returns the incremental events with `eventRevision > fromRevision` in
   * ascending order when the log still retains everything after that revision
   * (Req 9.3). When it cannot — the requested revision is below the compaction
   * watermark, or is not a valid non-negative integer — it returns a full
   * snapshot fallback so the agent replaces its cached state (Req 9.5). The
   * caller supplies the current authoritative snapshot (from
   * {@link serializeSessionState}) used for that fallback.
   */
  syncFrom(
    session: SessionId,
    fromRevision: number,
    snapshot: SessionStateSnapshot,
  ): SyncResponse {
    if (!this.canServeIncrementally(session, fromRevision)) {
      return { kind: "snapshot", snapshot };
    }
    const log = this.logs.get(sessionKey(session)) ?? [];
    const events = log
      .filter((update) => update.eventRevision > fromRevision)
      .map((update) => ({ ...update, member: { ...update.member } }));
    return { kind: "events", events };
  }
}

/**
 * Agent-side cache of coordination state that converges to the host's
 * authoritative state across a reconnect (Req 9.1, 9.4, 9.6, 33.4, 33.5;
 * design §4.6).
 *
 * The cache is the set of active coordination entries per `Repository_Session`
 * (keyed by {@link coordinationEntryKey}) plus, per session, the highest
 * Event_Revision applied (Req 9.1). A connection-level {@link stale} flag models
 * Offline_State staleness: {@link markStale} sets it on disconnect and a
 * completed {@link applySync} clears it (Req 6.6/33.5).
 *
 * Applying updates is idempotent and order-preserving: an update whose revision
 * is not greater than the session's highest applied is ignored (no re-applied
 * events), and applying the host's incremental suffix advances the cache exactly
 * to the authoritative state (no missed events). A snapshot response instead
 * *replaces* the session's entries wholesale via {@link projectSnapshot}
 * (Req 9.5). Either way the cache ends equal to the authoritative state.
 */
export class AgentSyncCache {
  /** `session_key` → (`coordinationEntryKey` → active entry). */
  private readonly entries = new Map<string, Map<string, CoordinationUpdate>>();

  /** `session_key` → highest Event_Revision applied for the session (Req 9.1). */
  private readonly highest = new Map<string, number>();

  /** Connection-level staleness (Offline_State) marker (Req 33.2/33.5). */
  private stale = false;

  private entriesFor(session: SessionId): Map<string, CoordinationUpdate> {
    const key = sessionKey(session);
    let map = this.entries.get(key);
    if (map === undefined) {
      map = new Map<string, CoordinationUpdate>();
      this.entries.set(key, map);
    }
    return map;
  }

  /**
   * The highest Event_Revision applied for a session (Req 9.1); `0` when nothing
   * has been applied yet. This is the `fromRevision` the agent sends on reconnect
   * (Req 9.2).
   */
  highestApplied(session: SessionId): number {
    return this.highest.get(sessionKey(session)) ?? 0;
  }

  /** True while the cached data is potentially stale (Offline_State, Req 33.2). */
  isStale(): boolean {
    return this.stale;
  }

  /**
   * Mark the cache stale on connectivity loss (Req 6.4/33.2). Cached data is
   * retained and still served; a completed {@link applySync} clears the marker.
   */
  markStale(): void {
    this.stale = true;
  }

  /**
   * Apply a single coordination update to a session's cache. Ignores an update
   * whose revision is not strictly greater than the session's highest applied
   * (idempotent — never re-applies an event); otherwise installs (`added`) or
   * removes (`removed`) the entry and advances the highest-applied revision.
   */
  private applyUpdate(session: SessionId, update: CoordinationUpdate): void {
    const key = sessionKey(session);
    const currentHighest = this.highest.get(key) ?? 0;
    if (update.eventRevision <= currentHighest) {
      return;
    }
    const map = this.entriesFor(session);
    const entryKey = coordinationEntryKey(update);
    if (update.op === "removed") {
      map.delete(entryKey);
    } else {
      map.set(entryKey, { ...update, member: { ...update.member } });
    }
    this.highest.set(key, update.eventRevision);
  }

  /**
   * Apply the host's incremental `sync.events` (Req 9.3/9.4). Events are applied
   * in ascending Event_Revision order; any already-applied event (revision `<=`
   * the highest applied) is skipped so nothing is re-applied, and each new event
   * advances the cache, leaving no gap when the host served a contiguous suffix.
   * Does **not** by itself clear staleness — {@link applySync} does that once the
   * whole sync completes.
   */
  applyEvents(session: SessionId, events: readonly CoordinationUpdate[]): void {
    const ordered = [...events].sort(
      (a, b) => a.eventRevision - b.eventRevision,
    );
    for (const update of ordered) {
      this.applyUpdate(session, update);
    }
  }

  /**
   * Replace a session's cached state with a full authoritative snapshot
   * (Req 9.5). Prior entries for the session are discarded and re-installed from
   * {@link projectSnapshot}, and the highest applied revision is set to the
   * snapshot's `highestRevision` so subsequent incremental syncs resume from the
   * right point. Because restore is a wholesale replacement, applying a snapshot
   * can only move the cache to the authoritative state, never leave stale entries
   * behind.
   */
  applySnapshot(session: SessionId, snapshot: SessionStateSnapshot): void {
    const map = new Map<string, CoordinationUpdate>();
    for (const entry of projectSnapshot(snapshot)) {
      map.set(coordinationEntryKey(entry), entry);
    }
    this.entries.set(sessionKey(session), map);
    this.highest.set(sessionKey(session), snapshot.highestRevision);
  }

  /**
   * Apply a reconnect {@link SyncResponse} and complete synchronization
   * (Req 9.4, 9.5, 33.4, 33.5). Dispatches to {@link applyEvents} or
   * {@link applySnapshot}, then clears the staleness marker since the cache is
   * now converged to the authoritative state (Req 6.6/33.5).
   */
  applySync(session: SessionId, response: SyncResponse): void {
    if (response.kind === "events") {
      this.applyEvents(session, response.events);
    } else {
      this.applySnapshot(session, response.snapshot);
    }
    this.stale = false;
  }

  /**
   * The current cached coordination entries for a session (the converged state),
   * in insertion order. Independent copies; mutating them never affects the
   * cache.
   */
  cachedEntries(session: SessionId): CoordinationUpdate[] {
    const map = this.entries.get(sessionKey(session));
    if (map === undefined) {
      return [];
    }
    return Array.from(map.values(), (entry) => ({
      ...entry,
      member: { ...entry.member },
    }));
  }
}
