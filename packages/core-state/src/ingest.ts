/**
 * The ingest gate: idempotency, replay, and schema/permission checks
 * (Req 7.4, 7.5, 7.7; design §4.4).
 *
 * Before the CoordinationHost mutates any authoritative coordination state it
 * runs every inbound Signed_Event through this single gate. The gate is the pure
 * embodiment of design §4.4's four guarantees, applied in an order chosen so that
 * a rejection provably leaves state unchanged and a legitimate retransmission is
 * never mistaken for an attack:
 *
 *   1. **Schema / version validation (Req 7.6, 7.7).** The event is validated
 *      with `@cfls/protocol` {@link validateSignedEvent}; a malformed envelope,
 *      unknown message type, unsupported message-format version, or payload that
 *      does not match its per-type schema is rejected with `FORMAT_ERROR` before
 *      anything else is touched.
 *   2. **Sender permission (Req 7.7).** A pluggable {@link PermissionCheck} (wired
 *      by the host to the Membership_Registry / session-authorization view) must
 *      permit the sender for the targeted session/action; otherwise the event is
 *      rejected with an auth error code and no state changes.
 *   3. **Idempotency (Req 7.4).** The gate keeps an applied-`Event_ID` index per
 *      session. A duplicate `eventId` is applied *at most once*: the gate returns
 *      the previously assigned Event_Revision (as `duplicateOf`) and performs no
 *      further work. Idempotency is checked *before* replay so that a genuine
 *      retransmission — which necessarily carries the same monotonic counter it
 *      used the first time — resolves to the original revision instead of being
 *      rejected as a stale replay.
 *   4. **Replay protection (Req 7.5).** The `@cfls/security` replay guard
 *      (per-device monotonic counter + nonce) rejects a `counter <= last-seen` or
 *      a reused nonce with `FORMAT_ERROR`, again leaving state unchanged.
 *
 * Only when all four checks pass does the gate assign the next monotonic
 * Event_Revision (via {@link RevisionCounter}), record the `Event_ID`, advance the
 * replay guard, and invoke the optional {@link Applier} that performs the actual
 * state mutation (locks/intents/presence/etc., implemented by later tasks). The
 * gate itself holds only metadata — counters, nonces, event ids, revisions —
 * never source content or secrets.
 *
 * Signature verification (Req 7.2, 7.3) is intentionally *not* performed here: it
 * requires the sending device's `Device_Public_Key` and is applied by the host
 * ingest pipeline using `@cfls/security` before an event reaches this gate.
 */

import {
  validateSignedEvent,
  type ErrorCode,
  type SessionId,
  type TypedEventEnvelope,
} from "@cfls/protocol";
import { createReplayGuard, type ReplayGuard } from "@cfls/security";

import { RevisionCounter } from "./revisions";
import { sessionKey } from "./session";

/** Outcome of a {@link PermissionCheck}. */
export type PermissionDecision =
  { permitted: true } | { permitted: false; code: ErrorCode; reason: string };

/**
 * Pluggable per-message authorization predicate (Req 7.7). The host supplies the
 * real check (session authorization, membership, etc.); the default
 * {@link permitAll} permits every validated envelope so the pure engine has no
 * membership knowledge baked in.
 */
export type PermissionCheck = (
  envelope: TypedEventEnvelope,
) => PermissionDecision;

/**
 * Side-effecting mutation applied exactly once for a newly accepted event, after
 * its Event_Revision has been assigned. Later tasks (locks, intents, presence,
 * dependency, …) provide the concrete applier; the gate guarantees it runs at
 * most once per `Event_ID`.
 */
export type Applier = (
  envelope: TypedEventEnvelope,
  eventRevision: number,
) => void;

/** The result of a single {@link IngestGate.ingest} call (design §3.1). */
export interface IngestResult {
  /** True when the event was accepted (including an idempotent duplicate). */
  accepted: boolean;
  /** The assigned (or, for a duplicate, previously assigned) Event_Revision. */
  eventRevision?: number;
  /** Set for an idempotent duplicate: the revision the first application got. */
  duplicateOf?: number;
  /** The rejection code when `accepted` is false (Req 7.3/7.5/7.6/7.7). */
  error?: ErrorCode;
  /** Human-readable rejection detail (never carries source content). */
  reason?: string;
}

/** A `(session, eventId, revision)` triple used to seed the applied index on restore. */
export type PersistedAppliedEvent = readonly [
  session: SessionId,
  eventId: string,
  eventRevision: number,
];

/** Construction options for an {@link IngestGate}. */
export interface IngestGateOptions {
  /**
   * The monotonic revision generator to stamp accepted events with. Shared with
   * the rest of the engine so revisions are globally consistent per session.
   * Defaults to a fresh {@link RevisionCounter}.
   */
  revisions?: RevisionCounter;
  /**
   * The per-device replay guard (`@cfls/security`). Defaults to a fresh
   * {@link createReplayGuard}. Supply a seeded guard to survive a restart.
   */
  replayGuard?: ReplayGuard;
  /** Sender-permission predicate (Req 7.7). Defaults to {@link permitAll}. */
  checkPermission?: PermissionCheck;
  /**
   * Applied-`Event_ID` records to resume after a restart (Req 7.4) so a duplicate
   * that arrives post-restart still resolves to its original revision.
   */
  appliedEvents?: Iterable<PersistedAppliedEvent>;
}

/** A {@link PermissionCheck} that permits every validated envelope. */
export const permitAll: PermissionCheck = () => ({ permitted: true });

/**
 * The ingest gate (Req 7.4, 7.5, 7.7; design §4.4).
 *
 * Stateful, in-memory, and I/O-free: it owns the applied-`Event_ID` index and
 * borrows a {@link RevisionCounter} and {@link ReplayGuard}. All rejections leave
 * every piece of tracked state untouched.
 */
export class IngestGate {
  private readonly revisions: RevisionCounter;
  private readonly replayGuard: ReplayGuard;
  private readonly checkPermission: PermissionCheck;

  /** Applied `Event_ID → Event_Revision`, partitioned by `session_key`. */
  private readonly appliedBySession = new Map<string, Map<string, number>>();

  constructor(options: IngestGateOptions = {}) {
    this.revisions = options.revisions ?? new RevisionCounter();
    this.replayGuard = options.replayGuard ?? createReplayGuard();
    this.checkPermission = options.checkPermission ?? permitAll;
    if (options.appliedEvents !== undefined) {
      for (const [session, eventId, eventRevision] of options.appliedEvents) {
        this.recordApplied(sessionKey(session), eventId, eventRevision);
      }
    }
  }

  /**
   * Run an inbound event through the gate (design §4.4).
   *
   * `input` is untrusted and may be any value: the gate validates it structurally
   * before use. When every check passes, `apply` (if provided) is invoked exactly
   * once with the validated envelope and its freshly assigned Event_Revision, and
   * the returned {@link IngestResult} carries `accepted: true` and `eventRevision`.
   *
   * On any rejection the result carries `accepted: false` and the relevant
   * {@link ErrorCode}, and no tracked state (revision counter, replay guard,
   * applied index) is mutated. A duplicate `Event_ID` yields `accepted: true`
   * with `duplicateOf` set and does not re-invoke `apply` (Req 7.4).
   */
  ingest(input: unknown, apply?: Applier): IngestResult {
    // 1. Schema / version validation (Req 7.6, 7.7) — before any state change.
    const validation = validateSignedEvent(input);
    if (!validation.ok) {
      return {
        accepted: false,
        error: validation.error.code,
        reason: validation.error.message,
      };
    }
    const { envelope } = validation.signedEvent;

    // 2. Sender permission (Req 7.7) — before any state change.
    const permission = this.checkPermission(envelope);
    if (!permission.permitted) {
      return {
        accepted: false,
        error: permission.code,
        reason: permission.reason,
      };
    }

    const key = sessionKey(envelope.session);

    // 3. Idempotency (Req 7.4): a duplicate Event_ID is applied at most once and
    //    returns the previously assigned revision; state is left unchanged.
    const priorRevision = this.appliedBySession.get(key)?.get(envelope.eventId);
    if (priorRevision !== undefined) {
      return {
        accepted: true,
        eventRevision: priorRevision,
        duplicateOf: priorRevision,
      };
    }

    // 4. Replay protection (Req 7.5): reject counter <= last-seen or a reused
    //    nonce; the guard leaves its per-device record unchanged on rejection.
    const replay = this.replayGuard.acceptReplay(
      envelope.deviceId,
      envelope.replay.counter,
      envelope.replay.nonce,
    );
    if (!replay.accepted) {
      return {
        accepted: false,
        error: replay.code,
        reason: replay.reason,
      };
    }

    // 5. Accept: assign the revision, record the Event_ID, apply exactly once.
    const eventRevision = this.revisions.next(envelope.session);
    this.recordApplied(key, envelope.eventId, eventRevision);
    apply?.(envelope, eventRevision);
    return { accepted: true, eventRevision };
  }

  /** Has an event with `eventId` already been applied for `session` (Req 7.4)? */
  hasApplied(session: SessionId, eventId: string): boolean {
    return (
      this.appliedBySession.get(sessionKey(session))?.has(eventId) ?? false
    );
  }

  /**
   * The Event_Revision previously assigned to `eventId` in `session`, or
   * `undefined` if the event has not been applied.
   */
  appliedRevision(session: SessionId, eventId: string): number | undefined {
    return this.appliedBySession.get(sessionKey(session))?.get(eventId);
  }

  /**
   * A read-only view of the applied-`Event_ID` index, keyed by `session_key`, for
   * persistence/inspection. Returns copies so callers cannot mutate gate state.
   */
  appliedSnapshot(): ReadonlyMap<string, ReadonlyMap<string, number>> {
    const out = new Map<string, ReadonlyMap<string, number>>();
    for (const [key, events] of this.appliedBySession) {
      out.set(key, new Map(events));
    }
    return out;
  }

  private recordApplied(
    key: string,
    eventId: string,
    eventRevision: number,
  ): void {
    const events = this.appliedBySession.get(key) ?? new Map<string, number>();
    events.set(eventId, eventRevision);
    this.appliedBySession.set(key, events);
  }
}
