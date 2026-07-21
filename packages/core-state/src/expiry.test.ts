/**
 * Unit tests for heartbeat tracking and the stale lock/intent expiry sweep
 * (Req 26.1–26.6; design §5.2, §13.4).
 *
 * Covers: config validation and bounds (Req 26.1, 26.3, 26.5); recording the
 * most-recent heartbeat and ignoring out-of-order receipts (Req 26.2);
 * stale-device detection at the Lock_Expiry_Interval boundary (Req 26.3); the
 * sweep releasing exactly the stale holder's locks/intents while leaving others
 * intact, with fresh Event_Revisions and `removed` updates (Req 26.3, 26.4);
 * per-session isolation; and the Soft_Lock 30-minute maximum-age cap (Req 26.5).
 */

import { describe, expect, it } from "vitest";

import type { MemberRef, SessionId } from "@cfls/protocol";

import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_LOCK_EXPIRY_INTERVAL_MS,
  DEFAULT_SOFT_LOCK_MAX_AGE_MS,
  ExpiryEngine,
  resolveExpiryConfig,
} from "./expiry";
import { IntentRegistry } from "./intents";
import { LockRegistry } from "./locks";
import { PresenceRegistry } from "./presence";
import { RevisionCounter } from "./revisions";

const session: SessionId = {
  repoId: "github.com/acme/app",
  teamId: "team-1",
  branch: "main",
  baseRevision: "base-1",
};
const otherSession: SessionId = { ...session, teamId: "team-2" };

const alice: MemberRef = { memberId: "alice", deviceId: "alice-dev-1" };
const bob: MemberRef = { memberId: "bob", deviceId: "bob-dev-1" };

interface Harness {
  locks: LockRegistry;
  intents: IntentRegistry;
  presence: PresenceRegistry;
  revisions: RevisionCounter;
  engine: ExpiryEngine;
}

function harness(config = {}): Harness {
  const locks = new LockRegistry("case-sensitive");
  const intents = new IntentRegistry("case-sensitive");
  const presence = new PresenceRegistry("case-sensitive");
  const revisions = new RevisionCounter();
  const engine = new ExpiryEngine(locks, intents, revisions, config, presence);
  return { locks, intents, presence, revisions, engine };
}

describe("resolveExpiryConfig (Req 26.1, 26.3, 26.5)", () => {
  it("applies the documented defaults", () => {
    expect(resolveExpiryConfig()).toEqual({
      heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
      lockExpiryIntervalMs: DEFAULT_LOCK_EXPIRY_INTERVAL_MS,
      softLockMaxAgeMs: DEFAULT_SOFT_LOCK_MAX_AGE_MS,
    });
  });

  it("accepts the interval bounds 5000–60000 ms", () => {
    expect(
      resolveExpiryConfig({
        heartbeatIntervalMs: 5_000,
        lockExpiryIntervalMs: 15_000,
      }),
    ).toMatchObject({ heartbeatIntervalMs: 5_000 });
    expect(
      resolveExpiryConfig({
        heartbeatIntervalMs: 60_000,
        lockExpiryIntervalMs: 180_000,
      }),
    ).toMatchObject({ heartbeatIntervalMs: 60_000 });
  });

  it("rejects a heartbeat interval below 5000 ms", () => {
    expect(() => resolveExpiryConfig({ heartbeatIntervalMs: 4_999 })).toThrow(
      RangeError,
    );
  });

  it("rejects a heartbeat interval above 60000 ms", () => {
    expect(() => resolveExpiryConfig({ heartbeatIntervalMs: 60_001 })).toThrow(
      RangeError,
    );
  });

  it("rejects a Lock_Expiry_Interval below 3× the heartbeat interval", () => {
    expect(() =>
      resolveExpiryConfig({
        heartbeatIntervalMs: 15_000,
        lockExpiryIntervalMs: 44_999,
      }),
    ).toThrow(RangeError);
  });

  it("rejects a non-positive soft-lock max age", () => {
    expect(() => resolveExpiryConfig({ softLockMaxAgeMs: 0 })).toThrow(
      RangeError,
    );
  });
});

describe("ExpiryEngine.recordHeartbeat / lastSeen (Req 26.2)", () => {
  it("records the receipt time as the most recent heartbeat", () => {
    const { engine } = harness();
    engine.recordHeartbeat(session, alice.deviceId, 1_000);
    expect(engine.lastSeen(session, alice.deviceId)).toBe(1_000);
    engine.recordHeartbeat(session, alice.deviceId, 5_000);
    expect(engine.lastSeen(session, alice.deviceId)).toBe(5_000);
  });

  it("ignores an out-of-order (older) heartbeat receipt", () => {
    const { engine } = harness();
    engine.recordHeartbeat(session, alice.deviceId, 5_000);
    engine.recordHeartbeat(session, alice.deviceId, 1_000);
    expect(engine.lastSeen(session, alice.deviceId)).toBe(5_000);
  });

  it("rejects a non-finite heartbeat time", () => {
    const { engine } = harness();
    expect(() =>
      engine.recordHeartbeat(session, alice.deviceId, Number.NaN),
    ).toThrow(RangeError);
  });

  it("isolates heartbeat tables per session", () => {
    const { engine } = harness();
    engine.recordHeartbeat(session, alice.deviceId, 1_000);
    expect(engine.lastSeen(otherSession, alice.deviceId)).toBeUndefined();
  });
});

describe("ExpiryEngine.staleDevices (Req 26.3)", () => {
  it("treats a device as stale only when strictly beyond the interval", () => {
    const { engine } = harness(); // lockExpiry = 45000
    engine.recordHeartbeat(session, alice.deviceId, 0);
    // now - lastSeen == interval → not yet stale
    expect(
      engine.staleDevices(session, DEFAULT_LOCK_EXPIRY_INTERVAL_MS),
    ).toEqual([]);
    // now - lastSeen > interval → stale
    expect(
      engine.staleDevices(session, DEFAULT_LOCK_EXPIRY_INTERVAL_MS + 1),
    ).toEqual([alice.deviceId]);
  });

  it("never reports a device with no recorded heartbeat", () => {
    const { engine } = harness();
    expect(engine.staleDevices(session, 1_000_000)).toEqual([]);
  });
});

describe("ExpiryEngine.sweep — heartbeat expiry (Req 26.3, 26.4)", () => {
  function seedLocksAndIntents(h: Harness): void {
    // Alice (will go stale) holds a lock + an intent.
    h.locks.acquire({
      session,
      lockId: "lock-alice",
      scope: "src/a.ts",
      scopeKind: "file",
      mode: "hard",
      holder: alice,
      branch: "main",
      eventRevision: h.revisions.next(session),
      acquiredAt: "2024-01-01T00:00:00.000Z",
    });
    h.intents.declare({
      session,
      intentId: "intent-alice",
      owner: alice,
      agentId: "agent-a",
      modifyPaths: ["src/a.ts"],
      createPaths: ["src/a.test.ts"],
      scopeKind: "file",
      branch: "main",
      description: "edit a",
      eventRevision: h.revisions.next(session),
    });
    // Bob (stays fresh) holds a lock + an intent.
    h.locks.acquire({
      session,
      lockId: "lock-bob",
      scope: "src/b.ts",
      scopeKind: "file",
      mode: "soft",
      holder: bob,
      branch: "main",
      eventRevision: h.revisions.next(session),
      acquiredAt: "2024-01-01T00:00:00.000Z",
    });
    h.intents.declare({
      session,
      intentId: "intent-bob",
      owner: bob,
      agentId: "agent-b",
      modifyPaths: ["src/b.ts"],
      createPaths: [],
      scopeKind: "file",
      branch: "main",
      description: "edit b",
      eventRevision: h.revisions.next(session),
    });
  }

  it("releases exactly the stale device's locks/intents and leaves others intact", () => {
    const h = harness();
    seedLocksAndIntents(h);
    h.engine.recordHeartbeat(session, alice.deviceId, 0);
    h.engine.recordHeartbeat(session, bob.deviceId, 100_000);

    const result = h.engine.sweep(session, 100_000);

    expect(result.expiredDevices).toEqual([alice.deviceId]);
    // Alice's lock + every intent path removed; Bob's untouched.
    expect(h.locks.allLocks(session).map((l) => l.lockId)).toEqual([
      "lock-bob",
    ]);
    expect(h.intents.allIntents(session).map((i) => i.intentId)).toEqual([
      "intent-bob",
    ]);
  });

  it("emits a removed update per released entry with fresh Event_Revisions", () => {
    const h = harness();
    seedLocksAndIntents(h);
    const revBefore = h.revisions.highest(session);
    h.engine.recordHeartbeat(session, alice.deviceId, 0);

    const result = h.engine.sweep(session, 100_000);

    expect(result.removals).toHaveLength(3);
    for (const update of result.removals) {
      expect(update.op).toBe("removed");
      expect(update.member).toEqual(alice);
      expect(update.eventRevision).toBeGreaterThan(revBefore);
    }
    const lockUpdate = result.removals.find((u) => u.entryType === "soft_lock");
    const intentUpdate = result.removals.find((u) => u.entryType === "intent");
    const creationUpdate = result.removals.find(
      (u) => u.entryType === "planned_file_creation",
    );
    expect(lockUpdate?.path).toBe("src/a.ts");
    expect(intentUpdate).toMatchObject({
      path: "src/a.ts",
      intent: { intentId: "intent-alice", description: "edit a" },
    });
    expect(creationUpdate).toMatchObject({
      path: "src/a.test.ts",
      intent: { intentId: "intent-alice", description: "edit a" },
    });
    // Revisions are unique and strictly increasing.
    const revs = result.removals.map((u) => u.eventRevision);
    expect(new Set(revs).size).toBe(revs.length);
  });

  it("drops the swept device so a second sweep is a no-op", () => {
    const h = harness();
    seedLocksAndIntents(h);
    h.engine.recordHeartbeat(session, alice.deviceId, 0);

    h.engine.sweep(session, 100_000);
    const second = h.engine.sweep(session, 200_000);

    expect(second.expiredDevices).toEqual([]);
    expect(second.removals).toEqual([]);
    expect(h.engine.lastSeen(session, alice.deviceId)).toBeUndefined();
  });

  it("does nothing when no device is stale", () => {
    const h = harness();
    seedLocksAndIntents(h);
    h.engine.recordHeartbeat(session, alice.deviceId, 90_000);
    h.engine.recordHeartbeat(session, bob.deviceId, 95_000);

    const result = h.engine.sweep(session, 100_000);

    expect(result.expiredDevices).toEqual([]);
    expect(result.removals).toEqual([]);
    expect(h.locks.allLocks(session)).toHaveLength(2);
    expect(h.intents.allIntents(session)).toHaveLength(2);
  });

  it("ends a stale device's active presence and emits removed updates", () => {
    const h = harness();
    h.presence.report({
      session,
      member: alice,
      path: "src/a.ts",
      state: "editing",
      eventRevision: h.revisions.next(session),
    });
    h.presence.report({
      session,
      member: alice,
      path: "src/a.test.ts",
      state: "started",
      eventRevision: h.revisions.next(session),
    });
    h.presence.report({
      session,
      member: bob,
      path: "src/b.ts",
      state: "editing",
      eventRevision: h.revisions.next(session),
    });
    const revisionBefore = h.revisions.highest(session);
    h.engine.recordHeartbeat(session, alice.deviceId, 0);
    h.engine.recordHeartbeat(session, bob.deviceId, 100_000);

    const result = h.engine.sweep(session, 100_000);
    const removals = result.removals.filter(
      (update) => update.entryType === "presence",
    );

    expect(removals).toEqual([
      expect.objectContaining({
        entryType: "presence",
        op: "removed",
        member: alice,
        path: "src/a.test.ts",
      }),
      expect.objectContaining({
        entryType: "presence",
        op: "removed",
        member: alice,
        path: "src/a.ts",
      }),
    ]);
    expect(
      removals.every((update) => update.eventRevision > revisionBefore),
    ).toBe(true);
    expect(h.presence.activeForDevice(session, alice.deviceId)).toEqual([]);
    expect(h.presence.activeForDevice(session, bob.deviceId)).toHaveLength(1);
  });

  it("announces the next winning claim when an expired winner is promoted", () => {
    const h = harness();
    h.locks.acquire({
      session,
      lockId: "lock-alice-winner",
      scope: "src/shared.ts",
      scopeKind: "file",
      mode: "soft",
      holder: alice,
      branch: "main",
      eventRevision: h.revisions.next(session),
      acquiredAt: "2024-01-01T00:00:00.000Z",
    });
    h.locks.acquire({
      session,
      lockId: "lock-bob-waiting",
      scope: "src/shared.ts",
      scopeKind: "file",
      mode: "soft",
      holder: bob,
      branch: "main",
      eventRevision: h.revisions.next(session),
      acquiredAt: "2024-01-01T00:00:01.000Z",
    });
    h.engine.recordHeartbeat(session, alice.deviceId, 0);
    h.engine.recordHeartbeat(session, bob.deviceId, 100_000);

    const result = h.engine.sweep(session, 100_000);

    expect(result.removals).toEqual([
      expect.objectContaining({
        entryType: "soft_lock",
        op: "removed",
        member: alice,
        path: "src/shared.ts",
      }),
    ]);
    expect(result.promotions).toEqual([
      expect.objectContaining({
        entryType: "soft_lock",
        op: "added",
        member: bob,
        path: "src/shared.ts",
      }),
    ]);
    expect(result.promotions[0]?.eventRevision).toBeGreaterThan(
      result.removals[0]?.eventRevision ?? 0,
    );
    expect(
      h.locks.winningLock(session, "src/shared.ts", "file", "main"),
    ).toMatchObject({ lockId: "lock-bob-waiting", concurrent: false });
  });
});

describe("ExpiryEngine.expireStaleSoftLocks — soft-lock max age (Req 26.5)", () => {
  it("releases soft locks older than the max age and leaves fresher/non-soft intact", () => {
    const h = harness();
    const acquiredAt = "2024-01-01T00:00:00.000Z";
    const acquiredMs = Date.parse(acquiredAt);

    // Old soft lock (should expire).
    h.locks.acquire({
      session,
      lockId: "soft-old",
      scope: "src/old.ts",
      scopeKind: "file",
      mode: "soft",
      holder: alice,
      branch: "main",
      eventRevision: h.revisions.next(session),
      acquiredAt,
    });
    // Old hard lock (must never age out).
    h.locks.acquire({
      session,
      lockId: "hard-old",
      scope: "src/hard.ts",
      scopeKind: "file",
      mode: "hard",
      holder: bob,
      branch: "main",
      eventRevision: h.revisions.next(session),
      acquiredAt,
    });

    // now is just past 30 min after acquisition.
    const now = acquiredMs + DEFAULT_SOFT_LOCK_MAX_AGE_MS + 1;
    const result = h.engine.expireStaleSoftLocks(session, now);

    expect(result.removals).toHaveLength(1);
    expect(result.removals[0]).toMatchObject({
      entryType: "soft_lock",
      op: "removed",
      path: "src/old.ts",
      member: alice,
    });
    expect(h.locks.allLocks(session).map((l) => l.lockId)).toEqual([
      "hard-old",
    ]);
  });

  it("keeps a soft lock exactly at the max-age boundary", () => {
    const h = harness();
    const acquiredAt = "2024-01-01T00:00:00.000Z";
    const acquiredMs = Date.parse(acquiredAt);
    h.locks.acquire({
      session,
      lockId: "soft-boundary",
      scope: "src/edge.ts",
      scopeKind: "file",
      mode: "soft",
      holder: alice,
      branch: "main",
      eventRevision: h.revisions.next(session),
      acquiredAt,
    });

    // now - acquired == maxAge → cutoff == acquired → not strictly older → kept.
    const result = h.engine.expireStaleSoftLocks(
      session,
      acquiredMs + DEFAULT_SOFT_LOCK_MAX_AGE_MS,
    );
    expect(result.removals).toEqual([]);
    expect(h.locks.allLocks(session)).toHaveLength(1);
  });
});
