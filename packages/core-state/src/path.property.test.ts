/**
 * Property 11 — Path normalization maps equivalents to one key.
 *
 * **Validates: Requirements 10.3, 10.4**
 *
 * Coordination keys every lock, presence, and intent by a repository-relative
 * path. The same file is routinely spelled several equivalent ways; if those
 * spellings produced different keys the same file would be tracked as two
 * distinct paths. This property asserts that every equivalent spelling of a
 * repository-relative path collapses to a single canonical key
 * (design §9.3, Property 11):
 *   - separator style — `\` (Windows) vs `/` — freely mixed (Req 10.3),
 *   - a leading `./` and redundant `.` / empty segments (`a//b`) (Req 10.3),
 *   - `..` segments that resolve back within the tree (a `x/..` detour) (Req 10.3),
 *   - and letter-case variants on case-insensitive platforms (Req 10.4).
 *
 * The test drives the real `normalizePathKey` (which composes `normalizePath`
 * and the platform-aware `pathMatchKey`) from ./path. It builds a canonical
 * path from clean segments, then generates an arbitrary equivalent spelling of
 * that path and asserts the spelling's key equals the canonical key.
 */

import { assertProperty, fc, propertyTag } from "@cfls/test-utils";
import { describe, expect, it } from "vitest";

import {
  normalizePathKey,
  type PlatformCaseSensitivity,
} from "./path";

/**
 * Clean path segment: alphanumeric only, so it is never `.`, `..`, empty, or a
 * separator. These form the canonical path whose equivalents we generate.
 */
const ALNUM =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split("");
const segmentArb = fc
  .array(fc.constantFrom(...ALNUM), { minLength: 1, maxLength: 6 })
  .map((chars) => chars.join(""));

/**
 * A specification of an equivalent spelling of a canonical path:
 *   - `segments`  — the canonical, clean path segments (source of truth),
 *   - `noise`     — per-gap `.`/empty tokens (redundant `.` and doubled seps),
 *   - `detours`   — per-gap optional `name/..` round-trips that resolve away,
 *   - `seps`      — per-join separator choices, freely mixing `\` and `/`,
 *   - `sensitivity` — the platform case-sensitivity to normalize under,
 *   - `recase`    — per-letter case-flip flags for the case-variant spelling.
 */
const equivalentSpelling = fc
  .array(segmentArb, { minLength: 1, maxLength: 6 })
  .chain((segments) => {
    const gaps = segments.length + 1; // before each segment + after the last
    return fc.record({
      segments: fc.constant(segments),
      noise: fc.array(fc.array(fc.constantFrom(".", ""), { maxLength: 3 }), {
        minLength: gaps,
        maxLength: gaps,
      }),
      detours: fc.array(fc.option(segmentArb, { nil: null }), {
        minLength: gaps,
        maxLength: gaps,
      }),
      seps: fc.array(fc.constantFrom("/", "\\"), {
        minLength: 1,
        maxLength: 40,
      }),
      sensitivity: fc.constantFrom<PlatformCaseSensitivity>(
        "case-sensitive",
        "case-insensitive",
      ),
      recase: fc.array(fc.boolean(), { minLength: 1, maxLength: 60 }),
    });
  });

/**
 * Interleave the canonical segments with redundant `.`/empty noise tokens and
 * `name/..` detours. A detour pushes a fresh segment immediately followed by
 * `..`, so it always cancels itself regardless of position — leaving the
 * resolved path exactly equal to `segments`.
 */
function buildTokens(
  segments: string[],
  noise: string[][],
  detours: (string | null)[],
): string[] {
  const tokens: string[] = [];
  for (let i = 0; i <= segments.length; i++) {
    for (const token of noise[i]!) tokens.push(token);
    const detour = detours[i];
    if (detour != null) {
      tokens.push(detour);
      tokens.push("..");
    }
    if (i < segments.length) tokens.push(segments[i]!);
  }
  return tokens;
}

/** Join tokens using a per-join separator, freely mixing `\` and `/`. */
function joinWithSeparators(tokens: string[], seps: string[]): string {
  if (tokens.length === 0) return "";
  let raw = tokens[0]!;
  for (let i = 1; i < tokens.length; i++) {
    raw += seps[(i - 1) % seps.length]! + tokens[i]!;
  }
  return raw;
}

/** Produce a case-variant of `raw` by flipping the case of chosen letters. */
function recaseLetters(raw: string, flags: boolean[]): string {
  let cursor = 0;
  return [...raw]
    .map((ch) => {
      if (!/[a-zA-Z]/.test(ch)) return ch;
      const flip = flags[cursor++ % flags.length]!;
      if (!flip) return ch;
      return ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase();
    })
    .join("");
}

describe(propertyTag(11, "Path normalization maps equivalents to one key"), () => {
  it("collapses separator, ./, redundant, .. and case variants to one canonical key", () => {
    assertProperty(
      fc.property(
        equivalentSpelling,
        ({ segments, noise, detours, seps, sensitivity, recase }) => {
          // The canonical key: segments joined by `/` are already normalized,
          // so this is the single key every equivalent spelling must match.
          const canonicalKey = normalizePathKey(segments.join("/"), sensitivity);

          const tokens = buildTokens(segments, noise, detours);
          const raw = joinWithSeparators(tokens, seps);

          // (a) Separator/`.`/redundant/`..` variants map to the canonical key
          //     on any platform.
          expect(normalizePathKey(raw, sensitivity)).toBe(canonicalKey);

          // (b) On case-insensitive platforms, a letter-case variant of the very
          //     same spelling also maps to the canonical key (Req 10.4).
          if (sensitivity === "case-insensitive") {
            const recased = recaseLetters(raw, recase);
            expect(normalizePathKey(recased, "case-insensitive")).toBe(
              canonicalKey,
            );
          }
        },
      ),
    );
  });
});
