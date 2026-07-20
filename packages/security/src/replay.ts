/**
 * Replay-protection counter and nonce logic (Req 7.5; design §4.4).
 *
 * Every Signed_Event envelope carries a per-device **monotonic `counter`** plus a
 * `nonce`. The host tracks, per device, the highest counter it has accepted and
 * the set of nonces it has already seen. An event is accepted only when it both
 *   (a) advances the counter (`counter > highestSeen`), and
 *   (b) presents a nonce not previously used by that device.
 * A `counter <= last-seen` (a replay or reorder) or a reused nonce is rejected,
 * and — critically — **state is left unchanged on rejection** (Property 4). This
 * is the gate the host applies before any authoritative state mutation.
 *
 * Two layers are provided:
 *   - {@link evaluateReplay} — a pure predicate over a single device's
 *     {@link ReplayRecord}. It never mutates; it returns both the decision and the
 *     next record so callers (and property tests) can reason functionally.
 *   - {@link createReplayGuard} — a small stateful wrapper that owns the per-device
 *     records and exposes {@link ReplayGuard.acceptReplay}`(deviceId, counter,
 *     nonce)`. It advances a device's record only when the event is accepted.
 *
 * The rejection code is the canonical protocol-level `FORMAT_ERROR` (§11.1): a
 * replayed or nonce-reusing envelope is an invalid message rejected before state
 * changes. This logic holds only metadata (counters, nonces) — never source
 * content or secrets.
 */

import type { ErrorCode } from "@cfls/protocol";

/**
 * The replay state retained for a single device: the highest counter accepted so
 * far and the set of nonces already consumed. Immutable — {@link evaluateReplay}
 * returns a fresh record rather than mutating this one.
 */
export interface ReplayRecord {
  /** Highest per-device counter accepted so far. */
  readonly highestCounter: number;
  /** Nonces already consumed by this device. */
  readonly usedNonces: ReadonlySet<string>;
}

/** The decision {@link evaluateReplay}/{@link ReplayGuard.acceptReplay} return. */
export type ReplayDecision =
  { accepted: true } | { accepted: false; code: ErrorCode; reason: string };

/** Result of a pure {@link evaluateReplay} step: decision plus the next record. */
export type ReplayEvaluation =
  | { accepted: true; record: ReplayRecord }
  | { accepted: false; code: ErrorCode; reason: string; record: ReplayRecord };

/** An empty {@link ReplayRecord} for a device that has not yet been seen. */
export function emptyReplayRecord(): ReplayRecord {
  return { highestCounter: 0, usedNonces: new Set<string>() };
}

/**
 * Pure replay predicate for one device (Req 7.5; design §4.4).
 *
 * Accepts iff `counter` is a valid, strictly-increasing counter (`> highestCounter`)
 * and `nonce` has not been used before by this device. On acceptance the returned
 * `record` advances the counter and records the nonce; on rejection the returned
 * `record` is the **same** `record` reference passed in, so rejection provably
 * leaves state unchanged (Property 4).
 *
 * A counter that is not a non-negative integer (NaN, Infinity, fractional, or
 * negative) is rejected as a malformed envelope (`FORMAT_ERROR`).
 */
export function evaluateReplay(
  record: ReplayRecord,
  counter: number,
  nonce: string,
): ReplayEvaluation {
  if (!Number.isInteger(counter) || counter < 0) {
    return {
      accepted: false,
      code: "FORMAT_ERROR",
      reason: "Replay counter must be a non-negative integer.",
      record,
    };
  }

  if (counter <= record.highestCounter) {
    return {
      accepted: false,
      code: "FORMAT_ERROR",
      reason: `Replay counter ${counter} is not greater than the last accepted counter ${record.highestCounter}.`,
      record,
    };
  }

  if (record.usedNonces.has(nonce)) {
    return {
      accepted: false,
      code: "FORMAT_ERROR",
      reason: "Replay nonce has already been used by this device.",
      record,
    };
  }

  const usedNonces = new Set(record.usedNonces);
  usedNonces.add(nonce);
  return {
    accepted: true,
    record: { highestCounter: counter, usedNonces },
  };
}

/**
 * Stateful replay gate keyed by device id. Tracks the highest accepted counter and
 * the used-nonce set per device and advances a device's record only when an event
 * is accepted. Rejection never mutates any device's record (Property 4).
 */
export interface ReplayGuard {
  /**
   * Accept or reject an event's replay data for `deviceId` (Req 7.5). Rejects a
   * `counter <= last-seen` or a nonce already used by the device, leaving state
   * unchanged; on acceptance advances the device's counter and records the nonce.
   */
  acceptReplay(
    deviceId: string,
    counter: number,
    nonce: string,
  ): ReplayDecision;
  /** The current {@link ReplayRecord} for a device, if it has been seen. */
  recordFor(deviceId: string): ReplayRecord | undefined;
  /** A read-only view of every device's replay record (for persistence/inspection). */
  snapshot(): ReadonlyMap<string, ReplayRecord>;
  /** Forget one device's replay state, or all devices when `deviceId` is omitted. */
  reset(deviceId?: string): void;
}

/**
 * Create a {@link ReplayGuard}. Optionally seed it with existing per-device records
 * (e.g. restored from persistence) so the highest counters and used nonces survive
 * a restart.
 */
export function createReplayGuard(
  seed?: Iterable<readonly [string, ReplayRecord]>,
): ReplayGuard {
  const records = new Map<string, ReplayRecord>();
  if (seed !== undefined) {
    for (const [deviceId, record] of seed) {
      records.set(deviceId, {
        highestCounter: record.highestCounter,
        usedNonces: new Set(record.usedNonces),
      });
    }
  }

  return {
    acceptReplay(deviceId, counter, nonce) {
      const current = records.get(deviceId) ?? emptyReplayRecord();
      const evaluation = evaluateReplay(current, counter, nonce);
      if (!evaluation.accepted) {
        return {
          accepted: false,
          code: evaluation.code,
          reason: evaluation.reason,
        };
      }
      records.set(deviceId, evaluation.record);
      return { accepted: true };
    },
    recordFor(deviceId) {
      return records.get(deviceId);
    },
    snapshot() {
      return new Map(records);
    },
    reset(deviceId) {
      if (deviceId === undefined) {
        records.clear();
      } else {
        records.delete(deviceId);
      }
    },
  };
}
