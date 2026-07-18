import fc from "fast-check";

/**
 * Shared property-based-testing (PBT) harness for the
 * `collaborative-file-lock-sync` feature.
 *
 * Every property test in this repository MUST:
 *   1. Run at least {@link MIN_PBT_RUNS} iterations (design "Testing Strategy" §13.1).
 *   2. Be tagged with the standard convention produced by {@link propertyTag}, i.e.
 *      `Feature: collaborative-file-lock-sync, Property N: <text>`.
 *
 * Use {@link assertProperty} (or {@link pbtParameters}) so the minimum run count is
 * enforced centrally and cannot be accidentally lowered per-test.
 */

/** Canonical feature name used in every PBT tag. */
export const FEATURE_NAME = "collaborative-file-lock-sync" as const;

/** Minimum number of iterations every property test must execute. */
export const MIN_PBT_RUNS = 100 as const;

/**
 * Build the standard PBT tag string for a numbered correctness property.
 *
 * @example
 * propertyTag(1, "Event_Revision monotonicity and total order")
 * // => "Feature: collaborative-file-lock-sync, Property 1: Event_Revision monotonicity and total order"
 */
export function propertyTag(propertyNumber: number, text: string): string {
  if (!Number.isInteger(propertyNumber) || propertyNumber < 1) {
    throw new RangeError(
      `propertyNumber must be a positive integer, received: ${String(propertyNumber)}`,
    );
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new RangeError("property tag text must not be empty");
  }
  return `Feature: ${FEATURE_NAME}, Property ${propertyNumber}: ${trimmed}`;
}

/**
 * Merge caller-provided fast-check parameters with the repo defaults, forcing
 * `numRuns` to be at least {@link MIN_PBT_RUNS}. A caller may raise the count but
 * never lower it below the enforced minimum.
 */
export function pbtParameters<Ts>(
  overrides: fc.Parameters<Ts> = {},
): fc.Parameters<Ts> {
  const requested = overrides.numRuns ?? MIN_PBT_RUNS;
  return { ...overrides, numRuns: Math.max(MIN_PBT_RUNS, requested) };
}

/**
 * Drop-in replacement for `fc.assert` that guarantees the minimum run count.
 * Supports both synchronous and asynchronous properties.
 */
export function assertProperty<Ts>(
  property: fc.IRawProperty<Ts>,
  overrides: fc.Parameters<Ts> = {},
): void | Promise<void> {
  return fc.assert(property, pbtParameters(overrides));
}

/** Re-export fast-check so tests import a single, consistent instance. */
export { fc };
export default fc;
