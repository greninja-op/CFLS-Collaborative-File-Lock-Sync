/**
 * Unit tests for the burst-window coalescing/deduplication engine
 * (task 4.22; Req 34.1–34.4; §8.5).
 */

import { describe, expect, it } from "vitest";

import type { MemberRef } from "@cfls/protocol";

import {
  Coalescer,
  DEFAULT_MAX_EVENTS_PER_WINDOW,
  DEFAULT_WINDOW_MS,
  MAX_WINDOW_MS,
  MIN_WINDOW_MS,
  type OutboundEvent,
} from "./coalesce";

const MEMBER: MemberRef = { memberId: "u-1", deviceId: "dev-1" };
const OTHER: MemberRef = { memberId: "u-2", deviceId: "dev-2" };

function ev(
  seq: number,
  path: string,
  state: string,
  overrides: Partial<OutboundEvent<string>> = {},
): OutboundEvent<string> {
  return {
    seq,
    kind: "presence",
    path,
    member: MEMBER,
    stateSignature: state,
    payload: state,
    ...overrides,
  };
}

describe("Coalescer window configuration (Req 34.1)", () => {
  it("defaults the window to 2 seconds", () => {
    expect(new Coalescer().windowMs).toBe(DEFAULT_WINDOW_MS);
    expect(DEFAULT_WINDOW_MS).toBe(2000);
  });

  it("clamps the window to the [1s, 10s] bounds", () => {
    expect(new Coalescer({ windowMs: 0 }).windowMs).toBe(MIN_WINDOW_MS);
    expect(new Coalescer({ windowMs: 500 }).windowMs).toBe(MIN_WINDOW_MS);
    expect(new Coalescer({ windowMs: 60000 }).windowMs).toBe(MAX_WINDOW_MS);
    expect(new Coalescer({ windowMs: 5000 }).windowMs).toBe(5000);
  });

  it("defaults the outbound rate bound", () => {
    expect(new Coalescer().maxEventsPerWindow).toBe(
      DEFAULT_MAX_EVENTS_PER_WINDOW,
    );
  });

  it("rejects a non-positive-integer rate bound", () => {
    expect(() => new Coalescer({ maxEventsPerWindow: 0 })).toThrow(RangeError);
    expect(() => new Coalescer({ maxEventsPerWindow: -1 })).toThrow(RangeError);
    expect(() => new Coalescer({ maxEventsPerWindow: 1.5 })).toThrow(
      RangeError,
    );
  });
});

describe("coalescing per path (Req 34.1, 34.3)", () => {
  it("collapses a burst on one path to its final state", () => {
    const c = new Coalescer<string>();
    c.enqueue(ev(1, "src/api.ts", "started"));
    c.enqueue(ev(2, "src/api.ts", "editing"));
    c.enqueue(ev(3, "src/api.ts", "stopped"));

    expect(c.pending).toBe(1);
    const out = c.flush();
    expect(out).toHaveLength(1);
    expect(out[0]?.stateSignature).toBe("stopped");
    expect(out[0]?.seq).toBe(3);
  });

  it("keeps distinct paths as separate coalesced events", () => {
    const c = new Coalescer<string>();
    c.enqueue(ev(1, "a.ts", "editing"));
    c.enqueue(ev(2, "b.ts", "editing"));
    c.enqueue(ev(3, "a.ts", "stopped"));

    const out = c.flush();
    expect(out).toHaveLength(2);
    const byPath = new Map(out.map((e) => [e.path, e.stateSignature]));
    expect(byPath.get("a.ts")).toBe("stopped");
    expect(byPath.get("b.ts")).toBe("editing");
  });

  it("collapses equivalent path spellings to one entry (Req 10.3–10.4)", () => {
    const c = new Coalescer<string>({ sensitivity: "case-insensitive" });
    c.enqueue(ev(1, "src/API.ts", "started"));
    c.enqueue(ev(2, "src/./api.ts", "editing"));

    expect(c.pending).toBe(1);
    const out = c.flush();
    expect(out).toHaveLength(1);
    expect(out[0]?.stateSignature).toBe("editing");
  });

  it("does not let a stale out-of-order event clobber a newer state", () => {
    const c = new Coalescer<string>();
    c.enqueue(ev(2, "a.ts", "editing"));
    c.enqueue(ev(1, "a.ts", "started")); // arrives late, lower seq

    const out = c.flush();
    expect(out).toHaveLength(1);
    expect(out[0]?.stateSignature).toBe("editing");
  });

  it("separates presence and lock changes on the same path", () => {
    const c = new Coalescer<string>();
    c.enqueue(ev(1, "a.ts", "editing", { kind: "presence" }));
    c.enqueue(ev(2, "a.ts", "acquired", { kind: "lock" }));

    const out = c.flush();
    expect(out).toHaveLength(2);
    expect(out.map((e) => e.kind).sort()).toEqual(["lock", "presence"]);
  });
});

describe("deduplication of identical events (Req 34.2)", () => {
  it("discards duplicate events for the same path and member within a window", () => {
    const c = new Coalescer<string>();
    c.enqueue(ev(1, "a.ts", "editing"));
    c.enqueue(ev(2, "a.ts", "editing")); // identical signature

    const out = c.flush();
    expect(out).toHaveLength(1);
    expect(out[0]?.stateSignature).toBe("editing");
  });

  it("suppresses a repeat of the last-sent state across windows", () => {
    const c = new Coalescer<string>();
    c.enqueue(ev(1, "a.ts", "editing"));
    expect(c.flush()).toHaveLength(1);

    // Same state again in a later window: nothing new to send.
    c.enqueue(ev(2, "a.ts", "editing"));
    expect(c.flush()).toHaveLength(0);
    expect(c.pending).toBe(0);
  });

  it("transmits a genuine state change after a duplicate is suppressed", () => {
    const c = new Coalescer<string>();
    c.enqueue(ev(1, "a.ts", "editing"));
    c.flush();
    c.enqueue(ev(2, "a.ts", "editing")); // suppressed
    c.flush();
    c.enqueue(ev(3, "a.ts", "stopped")); // real change

    const out = c.flush();
    expect(out).toHaveLength(1);
    expect(out[0]?.stateSignature).toBe("stopped");
  });

  it("does not dedup identical signatures across different members", () => {
    const c = new Coalescer<string>();
    c.enqueue(ev(1, "a.ts", "editing", { member: MEMBER }));
    c.enqueue(ev(2, "a.ts", "editing", { member: OTHER }));

    const out = c.flush();
    expect(out).toHaveLength(2);
  });
});

describe("outbound rate bound (Req 34.4)", () => {
  it("emits at most maxEventsPerWindow per flush and keeps the rest buffered", () => {
    const c = new Coalescer<string>({ maxEventsPerWindow: 2 });
    for (let i = 0; i < 5; i++) {
      c.enqueue(ev(i + 1, `f${i}.ts`, "editing"));
    }
    expect(c.pending).toBe(5);

    const first = c.flush();
    expect(first).toHaveLength(2);
    // Lowest sequences emitted first.
    expect(first.map((e) => e.seq)).toEqual([1, 2]);
    expect(c.pending).toBe(3);

    const second = c.flush();
    expect(second).toHaveLength(2);
    expect(second.map((e) => e.seq)).toEqual([3, 4]);

    const third = c.flush();
    expect(third).toHaveLength(1);
    expect(third.map((e) => e.seq)).toEqual([5]);
    expect(c.pending).toBe(0);
  });

  it("accepts events locally without dropping even when over the bound", () => {
    const c = new Coalescer<string>({ maxEventsPerWindow: 1 });
    c.enqueue(ev(1, "a.ts", "editing"));
    c.enqueue(ev(2, "b.ts", "editing"));
    c.enqueue(ev(3, "c.ts", "editing"));
    expect(c.pending).toBe(3);

    // All three eventually transmit across windows (final state preserved).
    const seen = [...c.flush(), ...c.flush(), ...c.flush()];
    expect(seen).toHaveLength(3);
    expect(new Set(seen.map((e) => e.path))).toEqual(
      new Set(["a.ts", "b.ts", "c.ts"]),
    );
  });

  it("transmits only the final state for a buffered path held back by the rate bound", () => {
    const c = new Coalescer<string>({ maxEventsPerWindow: 1 });
    c.enqueue(ev(1, "a.ts", "editing"));
    c.enqueue(ev(2, "b.ts", "started"));

    // a.ts wins the first window; b.ts stays buffered.
    expect(c.flush().map((e) => e.path)).toEqual(["a.ts"]);

    // b.ts changes again before it is ever transmitted.
    c.enqueue(ev(3, "b.ts", "stopped"));
    const out = c.flush();
    expect(out).toHaveLength(1);
    expect(out[0]?.path).toBe("b.ts");
    expect(out[0]?.stateSignature).toBe("stopped");
  });
});

describe("resetSentState (reconnect re-assert, Req 33.4)", () => {
  it("allows re-sending the same state after a reset", () => {
    const c = new Coalescer<string>();
    c.enqueue(ev(1, "a.ts", "editing"));
    expect(c.flush()).toHaveLength(1);

    c.resetSentState();
    c.enqueue(ev(2, "a.ts", "editing"));
    expect(c.flush()).toHaveLength(1);
  });
});

describe("empty flush", () => {
  it("returns nothing when no events are buffered", () => {
    expect(new Coalescer().flush()).toEqual([]);
  });
});
