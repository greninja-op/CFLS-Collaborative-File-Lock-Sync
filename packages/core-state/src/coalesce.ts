/**
 * Coalescing and deduplication of outbound coordination events within the burst
 * window (Req 34.1–34.4; design §8.5).
 *
 * The CoordinationAgent smooths rapid bursts of Presence_Events and lock changes
 * before they reach the CoordinationHost so that quickly opening many files or
 * toggling activity does not flood the host. {@link Coalescer} is the pure,
 * dependency-free (no I/O, no internal clock) engine that realizes that
 * behavior; the agent drives it from a window timer and its outbound WSS pump.
 *
 * The engine buffers events the caller enqueues locally and, at each window
 * boundary, produces the set of events to actually transmit:
 *
 *   - **Coalesce per path (Req 34.1, 34.3).** Events are grouped by a coalescing
 *     key of `(kind, member, normalized-path)`. Within a burst only the *latest*
 *     event per key (highest caller-assigned `seq`) is retained, so a run of
 *     presence/lock changes on one path collapses to a single event equal to
 *     that path's final state. Superseded earlier events in the same burst are
 *     dropped.
 *   - **Deduplicate identical events (Req 34.2).** Each key remembers the state
 *     signature it last transmitted. If the retained event's `stateSignature`
 *     equals what was last sent for that key, it is discarded rather than sent
 *     again — two or more identical presence/lock changes for the same path and
 *     Team_Member collapse to one transmission.
 *   - **Bound the outbound rate (Req 34.4).** {@link Coalescer.flush} emits at
 *     most `maxEventsPerWindow` events per window. Events are always accepted
 *     locally ({@link Coalescer.enqueue} never drops); when a window's candidate
 *     set exceeds the limit the remainder stays buffered (still coalesced to its
 *     final state) and is considered on the next flush, so the transmitted data
 *     always reflects the member's latest activity.
 *
 * The coalescing window is validated to the design's bounds: between 1 and 10
 * seconds, defaulting to 2 seconds (Req 34.1). The engine itself is clockless —
 * the caller owns the timer and calls {@link Coalescer.flush} at each boundary —
 * but {@link Coalescer.windowMs} exposes the clamped window so the agent's timer
 * uses a single validated source of truth.
 *
 * Paths are keyed by their platform-aware normalized matching key so equivalent
 * spellings of the same file collapse to one coalescing entry (Req 10.3–10.4),
 * consistent with the presence and lock registries.
 */

import type { MemberRef } from "@cfls/protocol";

import {
  normalizePath,
  pathMatchKey,
  type PlatformCaseSensitivity,
} from "./path";

/** The kinds of outbound coordination event the agent coalesces (Req 34.1). */
export type CoalescableKind = "presence" | "lock";

/** Default coalescing window (Req 34.1). */
export const DEFAULT_WINDOW_MS = 2000;
/** Minimum coalescing window (Req 34.1). */
export const MIN_WINDOW_MS = 1000;
/** Maximum coalescing window (Req 34.1). */
export const MAX_WINDOW_MS = 10000;
/** Default bound on events transmitted per window (Req 34.4). */
export const DEFAULT_MAX_EVENTS_PER_WINDOW = 20;

/**
 * A single outbound coordination event the agent wishes to transmit. The generic
 * `T` is the opaque payload carried verbatim to the transmitted output; the
 * engine only reasons about the key fields and {@link stateSignature}.
 */
export interface OutboundEvent<T = unknown> {
  /**
   * Caller-assigned monotonic local sequence number. Determines which event is
   * the *latest* for a key within a burst (higher wins) and the stable emission
   * order on flush. The caller (agent) owns this counter.
   */
  seq: number;
  /** Whether this is a Presence_Event or a lock change (Req 34.1). */
  kind: CoalescableKind;
  /** Repository-relative path the event concerns (normalized for keying). */
  path: string;
  /** The Team_Member (and device) the event originates from (Req 34.2). */
  member: MemberRef;
  /**
   * Stable signature of the event's *resulting state*, used for deduplication
   * (Req 34.2). Two events with the same coalescing key and the same signature
   * represent the same final state and collapse to a single transmission.
   */
  stateSignature: string;
  /** Opaque payload returned verbatim when the event is emitted by {@link Coalescer.flush}. */
  payload: T;
}

/** Options controlling the coalescing window and outbound rate bound. */
export interface CoalescerOptions {
  /**
   * Coalescing window in milliseconds. Clamped to `[MIN_WINDOW_MS, MAX_WINDOW_MS]`
   * and defaulting to {@link DEFAULT_WINDOW_MS} (Req 34.1). Exposed via
   * {@link Coalescer.windowMs} for the caller's timer; the engine is clockless.
   */
  windowMs?: number;
  /**
   * Maximum number of events emitted per {@link Coalescer.flush} — the outbound
   * rate bound (Req 34.4). Must be a positive integer; defaults to
   * {@link DEFAULT_MAX_EVENTS_PER_WINDOW}.
   */
  maxEventsPerWindow?: number;
  /** Platform case-sensitivity used to normalize paths for keying (Req 10.3–10.4). */
  sensitivity?: PlatformCaseSensitivity;
}

/** Compute the coalescing key `(kind, member, normalized-path)` for an event. */
function coalesceKey(
  event: OutboundEvent,
  sensitivity: PlatformCaseSensitivity | undefined,
): string {
  const pathKey = pathMatchKey(normalizePath(event.path), sensitivity);
  return `${event.kind}\u0000${event.member.memberId}\u0000${pathKey}`;
}

/** Clamp a requested window to the design's `[1s, 10s]` bounds (Req 34.1). */
function clampWindow(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return DEFAULT_WINDOW_MS;
  }
  return Math.min(
    MAX_WINDOW_MS,
    Math.max(MIN_WINDOW_MS, Math.trunc(requested)),
  );
}

/**
 * Pure in-memory coalescing/deduplication engine for outbound coordination
 * events (Req 34; §8.5).
 *
 * Not safe for concurrent mutation; the agent drives it from a single outbound
 * pump. All timing is the caller's responsibility.
 */
export class Coalescer<T = unknown> {
  /** Clamped coalescing window in ms (Req 34.1). */
  readonly windowMs: number;
  /** Outbound rate bound: max events emitted per {@link flush} (Req 34.4). */
  readonly maxEventsPerWindow: number;

  private readonly sensitivity: PlatformCaseSensitivity | undefined;

  /** coalescing key → the latest buffered event for that key (Req 34.1, 34.3). */
  private readonly buffered = new Map<string, OutboundEvent<T>>();

  /** coalescing key → the state signature last transmitted for that key (Req 34.2). */
  private readonly lastSent = new Map<string, string>();

  constructor(options: CoalescerOptions = {}) {
    this.windowMs = clampWindow(options.windowMs);

    const max = options.maxEventsPerWindow ?? DEFAULT_MAX_EVENTS_PER_WINDOW;
    if (!Number.isInteger(max) || max < 1) {
      throw new RangeError(
        `maxEventsPerWindow must be a positive integer, got ${max}.`,
      );
    }
    this.maxEventsPerWindow = max;
    this.sensitivity = options.sensitivity;
  }

  /**
   * Accept an outbound event locally (Req 34.4 — always accepted, never
   * dropped). Coalesces per key: the buffered event for a key is replaced only
   * when the incoming event is at least as recent (`seq >= buffered.seq`), so a
   * burst collapses to its final per-path state (Req 34.1, 34.3) and an
   * out-of-order stale event cannot clobber a newer one.
   */
  enqueue(event: OutboundEvent<T>): void {
    const key = coalesceKey(event, this.sensitivity);
    const existing = this.buffered.get(key);
    if (existing === undefined || event.seq >= existing.seq) {
      this.buffered.set(key, event);
    }
  }

  /** Number of coalescing keys currently buffered (winning events pending flush). */
  get pending(): number {
    return this.buffered.size;
  }

  /**
   * Produce the events to transmit for the elapsed window (Req 34.1–34.4).
   *
   * For each buffered key the retained (latest) event is a candidate unless its
   * {@link OutboundEvent.stateSignature} equals the signature last transmitted
   * for that key — identical duplicates are discarded (Req 34.2). Candidates are
   * emitted in ascending `seq` order and capped at {@link maxEventsPerWindow}
   * (Req 34.4); any events beyond the cap remain buffered for a later flush,
   * still coalesced to their final state (Req 34.3). Emitted keys record their
   * transmitted signature for future dedup, and duplicate-only entries are
   * cleared from the buffer.
   */
  flush(): OutboundEvent<T>[] {
    const candidates: { key: string; event: OutboundEvent<T> }[] = [];

    for (const [key, event] of this.buffered) {
      if (this.lastSent.get(key) === event.stateSignature) {
        // Identical to what was last sent for this key — discard (Req 34.2).
        this.buffered.delete(key);
        continue;
      }
      candidates.push({ key, event });
    }

    // Stable emission order: ascending local sequence (Req 34.1 "most recent").
    candidates.sort((a, b) => a.event.seq - b.event.seq);

    const emitted: OutboundEvent<T>[] = [];
    for (const { key, event } of candidates) {
      if (emitted.length >= this.maxEventsPerWindow) {
        // Outbound rate bound reached (Req 34.4): keep the rest buffered so the
        // next window still transmits their final state (Req 34.3).
        break;
      }
      emitted.push(event);
      this.lastSent.set(key, event.stateSignature);
      this.buffered.delete(key);
    }

    return emitted;
  }

  /**
   * Forget the last-transmitted signature for every key. After a reconnect the
   * agent re-asserts its still-held locks/intents (Req 33.4), so the next
   * enqueued state must be transmitted even if it matches what was sent before
   * the disconnect. Buffered (not-yet-sent) events are left intact.
   */
  resetSentState(): void {
    this.lastSent.clear();
  }
}
