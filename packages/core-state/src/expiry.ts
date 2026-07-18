/**
 * Heartbeat tracking and the stale lock/intent expiry sweep
 * (Req 26.1–26.6; design §5.2, §13.4).
 *
 * The CoordinationHost records a per-device liveness signal — the
 * {@link Heartbeat} — and automatically releases the locks and Declared_Intents
 * of any device that stops confirming its liveness. {@link ExpiryEngine} is the
 * pure, in-memory realization of that authority for the `core-state` package: it
 * owns the last-seen heartbeat table (design §5.2 `heartbeats`) and drives the
 * expiry sweep against the shared {@link LockRegistry} and {@link IntentRegistry}
 * using the authoritative {@link RevisionCounter}.
 *
 * ## Heartbeat tracking (Req 26.2)
 * {@link ExpiryEngine.recordHeartbeat} stores the receipt time as the *most
 * recent* heartbeat for `(session, deviceId)`; an out-of-order (older) receipt
 * never lowers a device's recorded liveness. Time is supplied by the caller as
 * epoch milliseconds so the engine itself reads no clock and stays deterministic
 * and dependency-free.
 *
 * ## Heartbeat expiry sweep (Req 26.3, 26.4)
 * {@link ExpiryEngine.sweep} releases **exactly** the locks and Declared_Intents
 * whose holder device's most recent heartbeat is older than the
 * `Lock_Expiry_Interval` (i.e. `now - lastSeen > lockExpiryIntervalMs`), and
 * leaves every other holder's state intact (Property 14). Each release is
 * assigned a fresh Event_Revision from the per-session counter and reported as a
 * `removed` {@link CoordinationUpdate} so the caller can broadcast it (Req 26.4).
 * A device with no recorded heartbeat has no "most recent heartbeat older than
 * the interval" and is therefore never swept.
 *
 * ## Soft-lock maximum age (Req 26.5)
 * Independently of heartbeats, a Soft_Lock is active only until it is released,
 * expired, or 30 minutes have elapsed since acquisition — whichever comes first.
 * {@link ExpiryEngine.expireStaleSoftLocks} releases soft-mode locks acquired
 * before the `now - softLockMaxAgeMs` cutoff, again emitting removals with fresh
 * revisions. This is kept separate from {@link ExpiryEngine.sweep} so the
 * heartbeat sweep's "exactly by heartbeat" contract (Property 14) stays clean.
 *
 * The agent-side heartbeat cadence (Req 26.1) and the editor→agent heartbeat
 * (Req 26.6) are transport concerns implemented by `apps/agent` and
 * `apps/vscode-extension`; this engine only defines and validates the interval
 * bounds those layers must honor.
 */

import type { CoordinationUpdate, SessionId } from "@cfls/protocol";

import type { IntentRegistry } from "./intents";
import type { LockRegistry } from "./locks";
import type { RevisionCounter } from "./revisions";
import { sessionKey } from "./session";

/** Default Heartbeat interval when unconfigured (Req 26.1). */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
/** Minimum permitted Heartbeat interval (Req 26.1). */
export const MIN_HEARTBEAT_INTERVAL_MS = 5_000;
/** Maximum permitted Heartbeat interval (Req 26.1). */
export const MAX_HEARTBEAT_INTERVAL_MS = 60_000;
/** Default Lock_Expiry_Interval when unconfigured (Req 26.3). */
export const DEFAULT_LOCK_EXPIRY_INTERVAL_MS = 45_000;
/** Minimum Lock_Expiry_Interval as a multiple of the Heartbeat interval (Req 26.3). */
export const MIN_LOCK_EXPIRY_INTERVAL_MULTIPLE = 3;
/** Default Soft_Lock maximum active age: 30 minutes since acquisition (Req 26.5). */
export const DEFAULT_SOFT_LOCK_MAX_AGE_MS = 30 * 60_000;

/** Caller-supplied expiry configuration; each field defaults when omitted. */
export interface ExpiryConfigInput {
  /** Heartbeat interval in ms; 5000–60000, default 15000 (Req 26.1). */
  heartbeatIntervalMs?: number;
  /** Lock_Expiry_Interval in ms; ≥ 3× heartbeat, default 45000 (Req 26.3). */
  lockExpiryIntervalMs?: number;
  /** Soft_Lock maximum active age in ms; > 0, default 1800000 (Req 26.5). */
  softLockMaxAgeMs?: number;
}

/** A fully resolved, validated expiry configuration. */
export interface ExpiryConfig {
  heartbeatIntervalMs: number;
  lockExpiryIntervalMs: number;
  softLockMaxAgeMs: number;
}

/** Outcome of an expiry sweep: the removals to broadcast and devices swept. */
export interface ExpirySweepResult {
  /**
   * One `removed` {@link CoordinationUpdate} per released lock/intent, each
   * carrying a freshly assigned Event_Revision (Req 26.4). Empty when nothing
   * expired.
   */
  removals: CoordinationUpdate[];
  /**
   * The device identifiers whose heartbeats were stale and were therefore
   * swept. Empty for {@link ExpiryEngine.expireStaleSoftLocks}, which is not
   * device-scoped.
   */
  expiredDevices: string[];
}

/**
 * Validate and resolve an {@link ExpiryConfigInput} into a concrete
 * {@link ExpiryConfig} (Req 26.1, 26.3, 26.5).
 *
 * @throws RangeError when the Heartbeat interval is outside 5000–60000 ms, the
 *   Lock_Expiry_Interval is below three times the Heartbeat interval, or the
 *   Soft_Lock max age is not a positive number.
 */
export function resolveExpiryConfig(input: ExpiryConfigInput = {}): ExpiryConfig {
  const heartbeatIntervalMs = input.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  if (
    !Number.isFinite(heartbeatIntervalMs) ||
    heartbeatIntervalMs < MIN_HEARTBEAT_INTERVAL_MS ||
    heartbeatIntervalMs > MAX_HEARTBEAT_INTERVAL_MS
  ) {
    throw new RangeError(
      `heartbeatIntervalMs must be between ${MIN_HEARTBEAT_INTERVAL_MS} and ` +
        `${MAX_HEARTBEAT_INTERVAL_MS} ms, got ${heartbeatIntervalMs}.`,
    );
  }

  const lockExpiryIntervalMs =
    input.lockExpiryIntervalMs ?? DEFAULT_LOCK_EXPIRY_INTERVAL_MS;
  const minExpiry = heartbeatIntervalMs * MIN_LOCK_EXPIRY_INTERVAL_MULTIPLE;
  if (!Number.isFinite(lockExpiryIntervalMs) || lockExpiryIntervalMs < minExpiry) {
    throw new RangeError(
      `lockExpiryIntervalMs must be at least ${MIN_LOCK_EXPIRY_INTERVAL_MULTIPLE}× the ` +
        `Heartbeat interval (${minExpiry} ms), got ${lockExpiryIntervalMs}.`,
    );
  }

  const softLockMaxAgeMs = input.softLockMaxAgeMs ?? DEFAULT_SOFT_LOCK_MAX_AGE_MS;
  if (!Number.isFinite(softLockMaxAgeMs) || softLockMaxAgeMs <= 0) {
    throw new RangeError(
      `softLockMaxAgeMs must be a positive number, got ${softLockMaxAgeMs}.`,
    );
  }

  return { heartbeatIntervalMs, lockExpiryIntervalMs, softLockMaxAgeMs };
}

/**
 * Pure in-memory heartbeat table + expiry sweep authority (Req 26; §5.2, §13.4).
 *
 * The engine holds no clock: every method that needs "now" takes it as an
 * explicit epoch-millisecond argument, keeping expiry deterministic and directly
 * testable. It mutates the supplied {@link LockRegistry}/{@link IntentRegistry}
 * (via their `expireByDevice` primitives) and draws Event_Revisions from the
 * shared {@link RevisionCounter}.
 */
export class ExpiryEngine {
  private readonly config: ExpiryConfig;

  /** `session_key` → (`deviceId` → most-recent heartbeat epoch ms). */
  private readonly heartbeats = new Map<string, Map<string, number>>();

  constructor(
    private readonly locks: LockRegistry,
    private readonly intents: IntentRegistry,
    private readonly revisions: RevisionCounter,
    config: ExpiryConfigInput = {},
  ) {
    this.config = resolveExpiryConfig(config);
  }

  /** The resolved, validated configuration in effect. */
  getConfig(): ExpiryConfig {
    return { ...this.config };
  }

  private tableFor(session: SessionId): Map<string, number> {
    const key = sessionKey(session);
    let table = this.heartbeats.get(key);
    if (table === undefined) {
      table = new Map<string, number>();
      this.heartbeats.set(key, table);
    }
    return table;
  }

  /**
   * Record the receipt of a Heartbeat from `deviceId` at `atMs` epoch ms
   * (Req 26.2). Only advances the device's recorded liveness: an out-of-order
   * receipt older than the stored value is ignored, so the table always reflects
   * the most recent heartbeat.
   *
   * @throws RangeError when `atMs` is not a finite number.
   */
  recordHeartbeat(session: SessionId, deviceId: string, atMs: number): void {
    if (!Number.isFinite(atMs)) {
      throw new RangeError(`Heartbeat time must be a finite number, got ${atMs}.`);
    }
    const table = this.tableFor(session);
    const existing = table.get(deviceId);
    if (existing === undefined || atMs > existing) {
      table.set(deviceId, atMs);
    }
  }

  /** The most recent recorded heartbeat for a device, or `undefined` if none. */
  lastSeen(session: SessionId, deviceId: string): number | undefined {
    return this.heartbeats.get(sessionKey(session))?.get(deviceId);
  }

  /**
   * Forget a device's heartbeat record (e.g. on an explicit disconnect). Safe to
   * call for an unknown device.
   */
  forgetDevice(session: SessionId, deviceId: string): void {
    this.heartbeats.get(sessionKey(session))?.delete(deviceId);
  }

  /**
   * The device identifiers whose most recent heartbeat is older than the
   * Lock_Expiry_Interval at `nowMs` — i.e. `nowMs - lastSeen > lockExpiry`
   * (Req 26.3). Returned sorted for deterministic sweep ordering. Devices with
   * no recorded heartbeat are never considered stale.
   */
  staleDevices(session: SessionId, nowMs: number): string[] {
    const table = this.heartbeats.get(sessionKey(session));
    if (table === undefined) {
      return [];
    }
    const stale: string[] = [];
    for (const [deviceId, lastSeen] of table) {
      if (nowMs - lastSeen > this.config.lockExpiryIntervalMs) {
        stale.push(deviceId);
      }
    }
    return stale.sort();
  }

  /**
   * Run the stale-heartbeat expiry sweep at `nowMs` (Req 26.3, 26.4).
   *
   * Releases every lock and removes every Declared_Intent held by a device whose
   * most recent heartbeat is older than the Lock_Expiry_Interval, and leaves all
   * other holders' state untouched (Property 14). Each release is assigned a
   * fresh Event_Revision and reported as a `removed` {@link CoordinationUpdate}.
   * A swept device's heartbeat record is dropped so a subsequent sweep does not
   * reprocess it; the device re-registers on its next heartbeat.
   */
  sweep(session: SessionId, nowMs: number): ExpirySweepResult {
    const expiredDevices = this.staleDevices(session, nowMs);
    const removals: CoordinationUpdate[] = [];
    const table = this.heartbeats.get(sessionKey(session));

    for (const deviceId of expiredDevices) {
      for (const lock of this.locks.expireByDevice(session, deviceId)) {
        removals.push({
          entryType: "soft_lock",
          op: "removed",
          path: lock.scope,
          member: lock.holder,
          eventRevision: this.revisions.next(session),
        });
      }
      for (const intent of this.intents.expireByDevice(session, deviceId)) {
        removals.push({
          entryType: "intent",
          op: "removed",
          member: intent.owner,
          eventRevision: this.revisions.next(session),
        });
      }
      table?.delete(deviceId);
    }

    return { removals, expiredDevices };
  }

  /**
   * Release soft-mode locks whose acquisition is older than the Soft_Lock
   * maximum age at `nowMs` (Req 26.5). Independent of heartbeats: a soft lock is
   * released once `nowMs - acquiredAt > softLockMaxAgeMs`, regardless of the
   * holder's liveness. Coordination-required and hard locks are never subject to
   * this cap. Each release is assigned a fresh Event_Revision and reported as a
   * `removed` {@link CoordinationUpdate}.
   */
  expireStaleSoftLocks(session: SessionId, nowMs: number): ExpirySweepResult {
    const cutoffMs = nowMs - this.config.softLockMaxAgeMs;
    const removals: CoordinationUpdate[] = [];
    for (const lock of this.locks.expireSoftLocksAcquiredBefore(session, cutoffMs)) {
      removals.push({
        entryType: "soft_lock",
        op: "removed",
        path: lock.scope,
        member: lock.holder,
        eventRevision: this.revisions.next(session),
      });
    }
    return { removals, expiredDevices: [] };
  }
}
