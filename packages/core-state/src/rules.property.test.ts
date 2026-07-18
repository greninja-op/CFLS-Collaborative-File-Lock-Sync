/**
 * Property 10 — Rules precedence is most-restrictive-wins.
 *
 * **Validates: Requirements 15.3, 15.4**
 *
 * A team's shared `Repository_Rules_Config` maps path globs to coordination
 * modes (`hard | coordination-required | soft`). When a repository-relative
 * path matches several globs the resolver must apply the strictest mode using
 * the total order `hard > coordination-required > soft` (Req 15.4), and any
 * path matching no glob must fall back to the config default — `soft` for a
 * well-formed config (Req 15.3). The decision must also be independent of the
 * order the rules happen to appear in the config (design §6, Property 10).
 *
 * The test drives the real `resolveMode`/`globMatch` from ./rules. Each rule is
 * generated with a *known* match/no-match intent so the expected set of
 * matching modes is derived independently of the resolver: matching rules use a
 * glob guaranteed to match (`**` or the path itself), and non-matching rules
 * use a single-segment underscore token that can never equal an alphanumeric
 * path segment. The property then asserts:
 *   (a) globMatch agrees with each rule's constructed match/no-match intent,
 *   (b) resolveMode equals the most restrictive of the matching modes plus the
 *       default (Req 15.4), which collapses to the default — `soft` here — when
 *       nothing matches (Req 15.3), and
 *   (c) the result is unchanged when the rule order is reversed (order-independence).
 */

import { assertProperty, fc, propertyTag } from "@cfls/test-utils";
import type { RiskLevel } from "@cfls/protocol";
import { describe, expect, it } from "vitest";

import {
  globMatch,
  resolveMode,
  type RepositoryRulesConfig,
  type RepositoryRuleEntry,
} from "./rules";

/** Independent restrictiveness oracle (least → most): soft < coord < hard. */
const RANK: Record<RiskLevel, number> = {
  soft: 0,
  "coordination-required": 1,
  hard: 2,
};

/** Oracle: most restrictive mode among `modes`, defaulting to `soft` when empty. */
function mostRestrictiveOracle(modes: readonly RiskLevel[]): RiskLevel {
  let winner: RiskLevel = "soft";
  for (const mode of modes) {
    if (RANK[mode] > RANK[winner]) winner = mode;
  }
  return winner;
}

const modeArb = fc.constantFrom<RiskLevel>(
  "soft",
  "coordination-required",
  "hard",
);

/** Clean, alphanumeric path segment: never `.`, `..`, empty, `/`, or `_`. */
const ALNUM =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split("");
const segmentArb = fc
  .array(fc.constantFrom(...ALNUM), { minLength: 1, maxLength: 6 })
  .map((chars) => chars.join(""));

/**
 * A rule spec pairs a *known* match intent with a mode. `exact` chooses between
 * the two guaranteed-matching globs (`**` and the literal path) when `matches`
 * is true; it is ignored otherwise.
 */
interface RuleSpec {
  readonly matches: boolean;
  readonly exact: boolean;
  readonly mode: RiskLevel;
}

const scenarioArb = fc
  .array(segmentArb, { minLength: 1, maxLength: 5 })
  .map((segments) => segments.join("/"))
  .chain((path) =>
    fc.record({
      path: fc.constant(path),
      defaultMode: modeArb,
      specs: fc.array(
        fc.record({
          matches: fc.boolean(),
          exact: fc.boolean(),
          mode: modeArb,
        }),
        { maxLength: 8 },
      ),
    }),
  );

/**
 * Turn a rule spec into a concrete {@link RepositoryRuleEntry} whose glob is
 * guaranteed (independently of the resolver) to match or not match `path`:
 *   - matching  → `**` (globstar) or the literal `path`,
 *   - no-match  → `__no__<i>`, a single underscore-token segment that can never
 *     equal an alphanumeric path segment and contains no wildcards.
 */
function materialize(
  spec: RuleSpec,
  index: number,
  path: string,
): RepositoryRuleEntry {
  if (!spec.matches) return { glob: `__no__${index}`, mode: spec.mode };
  return { glob: spec.exact ? path : "**", mode: spec.mode };
}

describe(propertyTag(10, "Rules precedence is most-restrictive-wins"), () => {
  it("resolves the strictest matching mode, defaults to soft, and ignores rule order", () => {
    assertProperty(
      fc.property(scenarioArb, ({ path, defaultMode, specs }) => {
        const rules = specs.map((spec, i) => materialize(spec, i, path));

        // (a) globMatch agrees with each rule's constructed match/no-match intent.
        specs.forEach((spec, i) => {
          expect(globMatch(rules[i]!.glob, path)).toBe(spec.matches);
        });

        const config: RepositoryRulesConfig = {
          version: 1,
          defaults: { mode: defaultMode },
          rules,
        };

        // Expected = most restrictive of the *matching* modes plus the default,
        // derived from the known intent rather than from the resolver.
        const matchingModes = specs
          .filter((spec) => spec.matches)
          .map((spec) => spec.mode);
        const expected = mostRestrictiveOracle([...matchingModes, defaultMode]);

        // (b) resolveMode picks the most-restrictive-wins mode (Req 15.4); with
        //     no matching rule and a soft default this collapses to soft (Req 15.3).
        expect(resolveMode(path, config)).toBe(expected);

        // (c) Order-independence: reversing the rules must not change the result.
        const reversed: RepositoryRulesConfig = {
          ...config,
          rules: [...rules].reverse(),
        };
        expect(resolveMode(path, reversed)).toBe(expected);

        // Explicit default-soft check (Req 15.3): with a soft default and only
        // the non-matching rules, every path resolves to soft.
        const softDefaultNoMatch: RepositoryRulesConfig = {
          version: 1,
          defaults: { mode: "soft" },
          rules: rules.filter((_, i) => !specs[i]!.matches),
        };
        expect(resolveMode(path, softDefaultNoMatch)).toBe("soft");
      }),
    );
  });
});
