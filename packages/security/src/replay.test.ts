/**
 * Unit tests for replay-protection counter and nonce logic (Req 7.5; design §4.4).
 * Covers: acceptance of strictly-increasing counters, rejection of counters
 * <= last-seen, rejection of reused nonces, per-device isolation, malformed
 * counters, seeding/snapshot round-trips, and — critically — that a rejection
 * leaves state unchanged (Property 4).
 */

import { describe, expect, it } from "vitest";

import {
  createReplayGuard,
  emptyReplayRecord,
  evaluateReplay,
  type ReplayRecord,
} from "./replay";

describe("evaluateReplay — pure predicate", () => {
  it("accepts a strictly-increasing counter with a fresh nonce", () => {
    const result = evaluateReplay(emptyReplayRecord(), 1, "n1");
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.record.highestCounter).toBe(1);
      expect(result.record.usedNonces.has("n1")).toBe(true);
    }
  });

  it("rejects a counter equal to the last accepted counter", () => {
    const record: ReplayRecord = { highestCounter: 5, usedNonces: new Set() };
    const result = evaluateReplay(record, 5, "n1");
    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.code).toBe("FORMAT_ERROR");
    }
  });

  it("rejects a counter below the last accepted counter", () => {
    const record: ReplayRecord = { highestCounter: 5, usedNonces: new Set() };
    const result = evaluateReplay(record, 4, "n1");
    expect(result.accepted).toBe(false);
  });

  it("rejects a reused nonce even when the counter advances", () => {
    const record: ReplayRecord = {
      highestCounter: 1,
      usedNonces: new Set(["n1"]),
    };
    const result = evaluateReplay(record, 2, "n1");
    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.code).toBe("FORMAT_ERROR");
      expect(result.reason).toContain("nonce");
    }
  });

  it("rejects malformed counters (NaN, fractional, negative, Infinity)", () => {
    const record = emptyReplayRecord();
    for (const bad of [Number.NaN, 1.5, -1, Number.POSITIVE_INFINITY]) {
      expect(evaluateReplay(record, bad, "n").accepted).toBe(false);
    }
  });

  it("leaves the record unchanged on rejection (Property 4)", () => {
    const record: ReplayRecord = {
      highestCounter: 5,
      usedNonces: new Set(["n1"]),
    };
    const result = evaluateReplay(record, 3, "n2");
    expect(result.accepted).toBe(false);
    // The returned record is the very same reference: no mutation occurred.
    if (!result.accepted) {
      expect(result.record).toBe(record);
      expect(result.record.highestCounter).toBe(5);
      expect(result.record.usedNonces.has("n2")).toBe(false);
    }
  });

  it("does not mutate the input record's nonce set on acceptance", () => {
    const record = emptyReplayRecord();
    evaluateReplay(record, 1, "n1");
    expect(record.usedNonces.has("n1")).toBe(false);
  });
});

describe("createReplayGuard — stateful gate", () => {
  it("accepts increasing counters and advances the device record", () => {
    const guard = createReplayGuard();
    expect(guard.acceptReplay("dev-1", 1, "a").accepted).toBe(true);
    expect(guard.acceptReplay("dev-1", 2, "b").accepted).toBe(true);
    expect(guard.recordFor("dev-1")?.highestCounter).toBe(2);
  });

  it("rejects a replayed counter and leaves the record unchanged", () => {
    const guard = createReplayGuard();
    guard.acceptReplay("dev-1", 10, "a");
    const before = guard.recordFor("dev-1");
    const result = guard.acceptReplay("dev-1", 10, "z");
    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.code).toBe("FORMAT_ERROR");
    }
    expect(guard.recordFor("dev-1")?.highestCounter).toBe(10);
    // A rejected event never records its nonce.
    expect(guard.recordFor("dev-1")?.usedNonces.has("z")).toBe(false);
    expect(before?.highestCounter).toBe(10);
  });

  it("rejects a reused nonce for the same device", () => {
    const guard = createReplayGuard();
    guard.acceptReplay("dev-1", 1, "shared");
    expect(guard.acceptReplay("dev-1", 2, "shared").accepted).toBe(false);
  });

  it("tracks counters and nonces independently per device", () => {
    const guard = createReplayGuard();
    guard.acceptReplay("dev-1", 5, "shared");
    // A different device starts fresh: low counter and same nonce both accepted.
    expect(guard.acceptReplay("dev-2", 1, "shared").accepted).toBe(true);
    expect(guard.recordFor("dev-1")?.highestCounter).toBe(5);
    expect(guard.recordFor("dev-2")?.highestCounter).toBe(1);
  });

  it("seeds from existing records and enforces monotonicity across restart", () => {
    const seeded = createReplayGuard([
      ["dev-1", { highestCounter: 100, usedNonces: new Set(["old"]) }],
    ]);
    expect(seeded.acceptReplay("dev-1", 100, "new").accepted).toBe(false);
    expect(seeded.acceptReplay("dev-1", 50, "new").accepted).toBe(false);
    expect(seeded.acceptReplay("dev-1", 101, "old").accepted).toBe(false);
    expect(seeded.acceptReplay("dev-1", 101, "new").accepted).toBe(true);
  });

  it("snapshot returns a detached copy of the per-device records", () => {
    const guard = createReplayGuard();
    guard.acceptReplay("dev-1", 1, "a");
    const snap = guard.snapshot();
    expect(snap.get("dev-1")?.highestCounter).toBe(1);
    // Mutating the guard afterwards does not change the earlier snapshot map.
    guard.acceptReplay("dev-1", 2, "b");
    expect(snap.get("dev-1")?.highestCounter).toBe(1);
  });

  it("reset forgets one device or all devices", () => {
    const guard = createReplayGuard();
    guard.acceptReplay("dev-1", 5, "a");
    guard.acceptReplay("dev-2", 5, "b");
    guard.reset("dev-1");
    expect(guard.recordFor("dev-1")).toBeUndefined();
    expect(guard.recordFor("dev-2")?.highestCounter).toBe(5);
    guard.reset();
    expect(guard.recordFor("dev-2")).toBeUndefined();
  });
});
