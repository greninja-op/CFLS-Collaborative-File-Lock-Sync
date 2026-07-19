/**
 * Unit tests for the exponential backoff schedule (task 9.9; Req 6.4).
 */

import { describe, expect, it } from "vitest";

import {
  ExponentialBackoff,
  backoffDelayForAttempt,
  backoffSchedule,
  resolveBackoffConfig,
} from "./backoff";

describe("backoffSchedule (Req 6.4)", () => {
  it("produces a doubling schedule capped at maxMs", () => {
    const schedule = backoffSchedule(8, { baseMs: 500, factor: 2, maxMs: 30_000 });
    expect(schedule).toEqual([500, 1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]);
  });

  it("respects a custom factor", () => {
    const schedule = backoffSchedule(4, { baseMs: 100, factor: 3, maxMs: 100_000 });
    expect(schedule).toEqual([100, 300, 900, 2700]);
  });

  it("is monotonically non-decreasing and never exceeds maxMs", () => {
    const config = resolveBackoffConfig({ baseMs: 250, factor: 2, maxMs: 10_000 });
    let previous = 0;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const delay = backoffDelayForAttempt(attempt, config);
      expect(delay).toBeGreaterThanOrEqual(previous);
      expect(delay).toBeLessThanOrEqual(10_000);
      previous = delay;
    }
  });
});

describe("ExponentialBackoff", () => {
  it("advances the attempt counter and resets on success", () => {
    const backoff = new ExponentialBackoff({ baseMs: 500, factor: 2, maxMs: 30_000 });
    expect(backoff.nextDelay()).toBe(500);
    expect(backoff.nextDelay()).toBe(1000);
    expect(backoff.nextDelay()).toBe(2000);
    backoff.reset();
    expect(backoff.nextDelay()).toBe(500);
  });

  it("applies deterministic full-jitter with an injected random source", () => {
    // random() = 0.5, jitter = 0.5 ⇒ factor 1 - 0.25 = 0.75.
    const backoff = new ExponentialBackoff({
      baseMs: 1000,
      factor: 2,
      maxMs: 30_000,
      jitter: 0.5,
      random: () => 0.5,
    });
    expect(backoff.nextDelay()).toBe(750); // 1000 * 0.75
    expect(backoff.nextDelay()).toBe(1500); // 2000 * 0.75
  });

  it("rejects invalid configuration", () => {
    expect(() => resolveBackoffConfig({ baseMs: 0 })).toThrow();
    expect(() => resolveBackoffConfig({ baseMs: 100, maxMs: 50 })).toThrow();
    expect(() => resolveBackoffConfig({ factor: 0.5 })).toThrow();
    expect(() => resolveBackoffConfig({ jitter: 2 })).toThrow();
  });
});
