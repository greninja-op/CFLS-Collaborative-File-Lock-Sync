/**
 * Exponential backoff schedule for the CoordinationAgent's single outbound WSS
 * connection (task 9.1; Req 6.4, 6.6; design §3.2, §8.4).
 *
 * When the agent loses its connection to the CoordinationHost it enters
 * Offline_State and retries with an exponentially increasing delay, capped at a
 * maximum, so a transient outage reconnects quickly while a prolonged outage
 * does not hammer the host. The schedule is a pure function of the attempt
 * number so it is deterministic and unit-testable; optional jitter is applied
 * only when a random source is supplied.
 */

/** Tunable parameters for {@link ExponentialBackoff}. */
export interface BackoffOptions {
  /** Delay before the first retry, in milliseconds (default 500ms). */
  baseMs?: number;
  /** Maximum delay any single retry may wait, in milliseconds (default 30s). */
  maxMs?: number;
  /** Multiplier applied per attempt (default 2 — i.e. true exponential). */
  factor?: number;
  /**
   * Full-jitter fraction in `[0, 1]` (default 0 — a deterministic schedule).
   * When `> 0`, the returned delay is multiplied by `1 - jitter*random()` so it
   * lands in `[delay*(1-jitter), delay]`, spreading reconnect storms.
   */
  jitter?: number;
  /** Injectable random source in `[0, 1)` for deterministic jitter tests. */
  random?: () => number;
}

/** Fully-resolved backoff configuration. */
export interface ResolvedBackoffConfig {
  baseMs: number;
  maxMs: number;
  factor: number;
  jitter: number;
}

const DEFAULTS: ResolvedBackoffConfig = {
  baseMs: 500,
  maxMs: 30_000,
  factor: 2,
  jitter: 0,
};

/** Resolve {@link BackoffOptions} against defaults, validating the ranges. */
export function resolveBackoffConfig(
  options: BackoffOptions = {},
): ResolvedBackoffConfig {
  const baseMs = options.baseMs ?? DEFAULTS.baseMs;
  const maxMs = options.maxMs ?? DEFAULTS.maxMs;
  const factor = options.factor ?? DEFAULTS.factor;
  const jitter = options.jitter ?? DEFAULTS.jitter;
  if (baseMs <= 0) {
    throw new RangeError("backoff baseMs must be positive.");
  }
  if (maxMs < baseMs) {
    throw new RangeError("backoff maxMs must be >= baseMs.");
  }
  if (factor < 1) {
    throw new RangeError("backoff factor must be >= 1.");
  }
  if (jitter < 0 || jitter > 1) {
    throw new RangeError("backoff jitter must be within [0, 1].");
  }
  return { baseMs, maxMs, factor, jitter };
}

/**
 * The un-jittered delay (ms) for a zero-based `attempt`: `base * factor^attempt`
 * clamped to `maxMs`. Pure and monotonic-non-decreasing in `attempt`, so it is
 * the deterministic backbone the property/unit tests assert.
 */
export function backoffDelayForAttempt(
  attempt: number,
  config: ResolvedBackoffConfig,
): number {
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new RangeError("backoff attempt must be a non-negative integer.");
  }
  const raw = config.baseMs * Math.pow(config.factor, attempt);
  return Math.min(config.maxMs, Math.round(raw));
}

/**
 * The deterministic (no-jitter) delay schedule for the first `count` attempts.
 * Handy for asserting the exact exponential curve in tests (Req 6.4).
 */
export function backoffSchedule(
  count: number,
  options: BackoffOptions = {},
): number[] {
  const config = resolveBackoffConfig(options);
  const out: number[] = [];
  for (let attempt = 0; attempt < count; attempt += 1) {
    out.push(backoffDelayForAttempt(attempt, config));
  }
  return out;
}

/**
 * Stateful exponential backoff used by the WSS client's reconnect loop. Each
 * {@link nextDelay} advances the attempt counter and returns the (optionally
 * jittered) delay; {@link reset} returns to the first attempt after a successful
 * connection.
 */
export class ExponentialBackoff {
  private readonly config: ResolvedBackoffConfig;
  private readonly random: () => number;
  private attempt = 0;

  constructor(options: BackoffOptions = {}) {
    this.config = resolveBackoffConfig(options);
    this.random = options.random ?? Math.random;
  }

  /** The zero-based number of the next attempt {@link nextDelay} will serve. */
  get currentAttempt(): number {
    return this.attempt;
  }

  /** Compute and consume the delay for the next reconnect attempt (ms). */
  nextDelay(): number {
    const base = backoffDelayForAttempt(this.attempt, this.config);
    this.attempt += 1;
    if (this.config.jitter === 0) {
      return base;
    }
    const factor = 1 - this.config.jitter * this.random();
    return Math.max(0, Math.round(base * factor));
  }

  /** Reset the schedule to the first attempt (call on a successful connect). */
  reset(): void {
    this.attempt = 0;
  }
}
