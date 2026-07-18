/**
 * Unit tests for monotonic Event_Revision assignment with restart resume
 * (Req 8.1, 1.6; design §4.5). Covers first-revision value, strict
 * monotonicity, per-session isolation, restart resume above the max persisted
 * revision, resume-only-raises, and input validation.
 *
 * The universal monotonicity/total-order property is covered separately by the
 * fast-check property test in task 4.5 (Property 1).
 */

import { describe, expect, it } from "vitest";

import type { SessionId } from "@cfls/protocol";

import { RevisionCounter } from "./revisions";

const sessionA: SessionId = {
  repoId: "github.com/acme/app",
  teamId: "team-1",
  branch: "main",
  baseRevision: "abc123",
};

const sessionB: SessionId = {
  ...sessionA,
  branch: "dev",
};

describe("RevisionCounter.next (Req 8.1)", () => {
  it("assigns 1 as the first revision for a session", () => {
    const counter = new RevisionCounter();
    expect(counter.next(sessionA)).toBe(1);
  });

  it("assigns strictly increasing consecutive revisions", () => {
    const counter = new RevisionCounter();
    const assigned = [
      counter.next(sessionA),
      counter.next(sessionA),
      counter.next(sessionA),
      counter.next(sessionA),
    ];
    expect(assigned).toEqual([1, 2, 3, 4]);
  });

  it("never repeats a revision within a session (uniqueness)", () => {
    const counter = new RevisionCounter();
    const seen = new Set<number>();
    for (let i = 0; i < 100; i += 1) {
      const revision = counter.next(sessionA);
      expect(seen.has(revision)).toBe(false);
      seen.add(revision);
    }
  });

  it("tracks revisions independently per session", () => {
    const counter = new RevisionCounter();
    expect(counter.next(sessionA)).toBe(1);
    expect(counter.next(sessionA)).toBe(2);
    // A different session starts from its own zero.
    expect(counter.next(sessionB)).toBe(1);
    expect(counter.next(sessionA)).toBe(3);
    expect(counter.next(sessionB)).toBe(2);
  });
});

describe("RevisionCounter.highest", () => {
  it("is 0 before any assignment", () => {
    const counter = new RevisionCounter();
    expect(counter.highest(sessionA)).toBe(0);
  });

  it("reflects the most recently assigned revision", () => {
    const counter = new RevisionCounter();
    counter.next(sessionA);
    counter.next(sessionA);
    expect(counter.highest(sessionA)).toBe(2);
    expect(counter.highest(sessionB)).toBe(0);
  });
});

describe("RevisionCounter restart resume (Req 1.6)", () => {
  it("resumes above the max persisted revision via resume()", () => {
    const counter = new RevisionCounter();
    counter.resume(sessionA, 42);
    expect(counter.highest(sessionA)).toBe(42);
    expect(counter.next(sessionA)).toBe(43);
  });

  it("resumes above the max persisted revision via the constructor seed", () => {
    const counter = new RevisionCounter([
      [sessionA, 100],
      [sessionB, 7],
    ]);
    expect(counter.next(sessionA)).toBe(101);
    expect(counter.next(sessionB)).toBe(8);
  });

  it("resume only raises the counter, never lowering it", () => {
    const counter = new RevisionCounter();
    counter.next(sessionA); // 1
    counter.next(sessionA); // 2
    counter.next(sessionA); // 3
    // A stale/lower persisted value must not rewind the counter.
    counter.resume(sessionA, 1);
    expect(counter.highest(sessionA)).toBe(3);
    expect(counter.next(sessionA)).toBe(4);
  });

  it("resuming from 0 leaves the first assignment at 1", () => {
    const counter = new RevisionCounter();
    counter.resume(sessionA, 0);
    expect(counter.next(sessionA)).toBe(1);
  });

  it("guarantees no post-restart revision collides with a persisted one", () => {
    // Simulate a run that assigned up to revision 5, then a restart.
    const first = new RevisionCounter();
    let highest = 0;
    for (let i = 0; i < 5; i += 1) {
      highest = first.next(sessionA);
    }
    const resumed = new RevisionCounter([[sessionA, highest]]);
    expect(resumed.next(sessionA)).toBeGreaterThan(highest);
  });
});

describe("RevisionCounter.resume validation", () => {
  it("rejects a negative persisted revision", () => {
    const counter = new RevisionCounter();
    expect(() => counter.resume(sessionA, -1)).toThrow(RangeError);
  });

  it("rejects a non-integer persisted revision", () => {
    const counter = new RevisionCounter();
    expect(() => counter.resume(sessionA, 3.5)).toThrow(RangeError);
  });
});
