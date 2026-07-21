/**
 * Monotonic Event_Revision assignment with restart resume (Req 8.1, 1.6; §4.5).
 *
 * The CoordinationHost is the definitive ordering authority: every accepted
 * coordination event is stamped with a **monotonically increasing
 * Event_Revision** that is unique and strictly ordered *within a single
 * `Repository_Session`* (Req 8.1). The revision — never a raw client timestamp —
 * is the authoritative order and the definitive conflict resolver.
 *
 * {@link RevisionCounter} realizes design §4.5: it holds one `++counter` per
 * session (keyed by the opaque {@link sessionKey}) so revisions in different
 * sessions are independent and never interfere. {@link RevisionCounter.next}
 * assigns `revision = ++counter[session]`, guaranteeing:
 *   - **uniqueness** — no revision is ever assigned twice for a session;
 *   - **strict monotonicity** — each assignment is exactly one greater than the
 *     previous, so the assignment order is the revision order.
 *
 * On host restart the authoritative state is restored from durable storage and
 * the counter must **resume above every previously assigned revision** for each
 * session (Req 1.6). {@link RevisionCounter.resume} (and the constructor's
 * persisted seed) sets the counter to the maximum persisted revision so the next
 * assignment is strictly greater than anything issued before the restart. Resume
 * only ever raises a counter, so restoring stale or out-of-order snapshots can
 * never hand out a revision that was already used.
 */

import type { SessionId } from "@cfls/protocol";

import { sessionKey } from "./session";

/** A `(session, maxPersistedRevision)` pair used to seed the counter on restore. */
export type PersistedRevision = readonly [
  session: SessionId,
  maxPersistedRevision: number,
];

/**
 * Per-session monotonic Event_Revision generator (Req 8.1, 1.6; §4.5).
 *
 * Instances are pure in-memory state with no I/O. Callers persist the highest
 * assigned revision per session elsewhere (the host `Store`) and rehydrate a new
 * counter after a restart via the constructor seed or {@link resume}.
 */
export class RevisionCounter {
  /** Highest revision assigned per `session_key`. Absent key ⇒ nothing assigned. */
  private readonly counters = new Map<string, number>();

  /**
   * Create a counter, optionally resuming from persisted per-session maxima so
   * that the first assignment for each seeded session is strictly greater than
   * its persisted revision (Req 1.6).
   */
  constructor(persisted?: Iterable<PersistedRevision>) {
    if (persisted !== undefined) {
      for (const [session, maxPersistedRevision] of persisted) {
        this.resume(session, maxPersistedRevision);
      }
    }
  }

  /**
   * Assign and return the next Event_Revision for `session` (Req 8.1).
   *
   * Computes `revision = ++counter[session]`: the first call for a session
   * returns `1`, and each subsequent call returns exactly one more than the
   * previous, so revisions are unique and strictly ordered within the session.
   */
  next(session: SessionId): number {
    const key = sessionKey(session);
    const nextRevision = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, nextRevision);
    return nextRevision;
  }

  /**
   * Return the highest revision assigned so far for `session`, or `0` if none
   * has been assigned (revisions are positive, starting at `1`).
   */
  highest(session: SessionId): number {
    return this.counters.get(sessionKey(session)) ?? 0;
  }

  /**
   * Resume `session`'s counter above a persisted revision on restore (Req 1.6).
   *
   * After this call the next {@link next} for the session returns a revision
   * strictly greater than `maxPersistedRevision`. Resuming only ever raises the
   * counter, so it can never cause a previously assigned revision to be reused.
   *
   * @throws if `maxPersistedRevision` is not a non-negative integer.
   */
  resume(session: SessionId, maxPersistedRevision: number): void {
    if (!Number.isInteger(maxPersistedRevision) || maxPersistedRevision < 0) {
      throw new RangeError(
        `maxPersistedRevision must be a non-negative integer, got ${maxPersistedRevision}.`,
      );
    }
    const key = sessionKey(session);
    const existing = this.counters.get(key) ?? 0;
    this.counters.set(key, Math.max(existing, maxPersistedRevision));
  }

  /**
   * Restore an exact synchronous-transaction checkpoint. Unlike {@link resume},
   * this may lower the counter and is intentionally reserved for a caller that
   * has rolled back every state effect created after the checkpoint before any
   * of them became observable or durable. Normal restart recovery must use
   * {@link resume}, which never rewinds.
   */
  restoreCheckpoint(session: SessionId, highestRevision: number): void {
    if (!Number.isInteger(highestRevision) || highestRevision < 0) {
      throw new RangeError(
        `highestRevision must be a non-negative integer, got ${highestRevision}.`,
      );
    }
    const key = sessionKey(session);
    if (highestRevision === 0) {
      this.counters.delete(key);
    } else {
      this.counters.set(key, highestRevision);
    }
  }
}
