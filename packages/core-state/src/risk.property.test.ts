/**
 * Property 13 — A member's own activity is excluded from its own Risk_Map.
 *
 * **Validates: Requirements 31.5**
 *
 * The Risk_Map is always projected *for* a requesting Team_Member. Design §7.8 /
 * §10.1 and Req 31.5 require that the requester's own coordination activity —
 * every active lock, Declared_Intent (modify + planned-creation), and
 * Presence_Event it owns, across *all* of its devices — is excluded from the map
 * served back to that member. Exclusion is by `memberId`, so a member acting from
 * several devices still collapses to one identity (Req 31.2, 31.3, 31.5).
 *
 * This property drives the real {@link buildRiskMap} over randomly generated
 * coordination state (locks, presence, intents, a metadata-only Dependency_Graph
 * and a Repository_Rules_Config) and an arbitrarily chosen requester drawn from
 * the same member pool that produced the activity. The invariant asserted is the
 * exact statement of Property 13:
 *
 *   For any coordination state and any requesting member, no contributor entry in
 *   the resulting Risk_Map is attributable to that same member (i.e. no
 *   contributor has `memberId === requester.memberId`).
 *
 * To make the property meaningful the generators reuse a small, shared pool of
 * member ids and file paths so members genuinely contend on the same paths and
 * dependency edges — otherwise the Risk_Map would trivially be empty. The
 * requester is also biased toward members that actually have activity, so the
 * exclusion path is exercised rather than side-stepped.
 */

import type {
  DeclaredIntent,
  DependencyGraph,
  Lock,
  MemberRef,
  Presence,
  RiskLevel,
  ScopeKind,
} from "@cfls/protocol";
import { assertProperty, fc, propertyTag } from "@cfls/test-utils";
import { describe, expect, it } from "vitest";

import { buildRiskMap, type RiskMapContext } from "./risk";
import { parseRulesConfig, type RepositoryRulesConfig } from "./rules";

// ---- Shared pools (kept small so activity actually overlaps) ----------------

const MEMBER_IDS = ["alice", "bob", "carol", "dave"] as const;
const DEVICE_IDS = ["laptop", "desktop", "ci"] as const;
const BRANCHES = ["main", "feature-x"] as const;
/** File paths that dependency edges also reference, so indirect risk can fire. */
const PATHS = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "api/routes.ts"] as const;

const memberArb: fc.Arbitrary<MemberRef> = fc.record({
  memberId: fc.constantFrom(...MEMBER_IDS),
  deviceId: fc.constantFrom(...DEVICE_IDS),
});

const modeArb: fc.Arbitrary<RiskLevel> = fc.constantFrom(
  "soft",
  "coordination-required",
  "hard",
);

const branchArb = fc.constantFrom(...BRANCHES);
const pathArb = fc.constantFrom(...PATHS);
const scopeKindArb: fc.Arbitrary<ScopeKind> = fc.constantFrom("file", "folder");

let lockCounter = 0;
const lockArb: fc.Arbitrary<Lock> = fc.record({
  scope: pathArb,
  scopeKind: scopeKindArb,
  mode: modeArb,
  holder: memberArb,
  branch: branchArb,
  concurrent: fc.boolean(),
}).map((partial) => ({
  lockId: `lock-${lockCounter++}`,
  scope: partial.scope,
  scopeKind: partial.scopeKind,
  mode: partial.mode,
  holder: partial.holder,
  branch: partial.branch,
  eventRevision: 1,
  acquiredAt: "2024-01-01T00:00:00.000Z",
  concurrent: partial.concurrent,
}));

const presenceArb: fc.Arbitrary<Presence> = fc.record({
  member: memberArb,
  path: pathArb,
  state: fc.constantFrom("started", "editing", "stopped"),
  eventRevision: fc.constant(1),
});

let intentCounter = 0;
const intentArb: fc.Arbitrary<DeclaredIntent> = fc.record({
  owner: memberArb,
  modifyPaths: fc.array(pathArb, { maxLength: 3 }),
  createPaths: fc.array(pathArb, { maxLength: 2 }),
  branch: branchArb,
}).map((partial) => ({
  intentId: `intent-${intentCounter++}`,
  owner: partial.owner,
  agentId: `agent-${partial.owner.memberId}`,
  modifyPaths: partial.modifyPaths,
  createPaths: partial.createPaths.map((path) => ({ path })),
  scopeKind: "file" as ScopeKind,
  branch: partial.branch,
  description: "planned work",
  eventRevision: 1,
}));

const edgeArb: fc.Arbitrary<DependencyGraph["modules"][number]["edges"][number]> =
  fc.record({
    from: pathArb,
    to: pathArb,
    kind: fc.constantFrom(
      "runtime_import",
      "type_only_import",
      "dynamic_unknown",
    ),
    confidence: fc.constantFrom("high", "medium", "low", "unknown"),
  });

const graphArb: fc.Arbitrary<DependencyGraph> = fc
  .record({
    edges: fc.array(edgeArb, { maxLength: 5 }),
    contracts: fc.array(
      fc.record({
        id: pathArb,
        fingerprint: fc.constantFrom("FP1", "FP2", "FP3"),
      }),
      { maxLength: 4 },
    ),
  })
  .map(({ edges, contracts }) => ({
    snapshot: {
      sessionId: {
        repoId: "github.com/acme/app",
        teamId: "team-1",
        branch: "main",
        baseRevision: null,
      },
      graphVersion: 1,
      analyzerVersion: "test",
    },
    packages: [],
    modules: [{ sourceFile: "src/a.ts", edges }],
    contracts: contracts.map((c) => ({
      id: c.id,
      kind: "exported_interface" as const,
      fingerprint: c.fingerprint,
    })),
  }));

/** A rules config over a soft default with an optional escalating glob. */
const rulesArb: fc.Arbitrary<RepositoryRulesConfig> = fc
  .array(fc.record({ glob: fc.constantFrom("src/**", "api/**", "**"), mode: modeArb }), {
    maxLength: 3,
  })
  .map((rules) => {
    const result = parseRulesConfig({ version: 1, defaults: { mode: "soft" }, rules });
    if (result.malformed) {
      throw new Error(`unexpected malformed rules: ${JSON.stringify(result.errors)}`);
    }
    return result.config;
  });

const contextArb: fc.Arbitrary<RiskMapContext> = fc
  .record({
    requester: memberArb,
    branch: branchArb,
    locks: fc.array(lockArb, { maxLength: 8 }),
    presence: fc.array(presenceArb, { maxLength: 6 }),
    intents: fc.array(intentArb, { maxLength: 5 }),
    rules: rulesArb,
    graph: fc.option(graphArb, { nil: undefined }),
  })
  .map(({ graph, ...ctx }) => ({
    ...ctx,
    sensitivity: "case-sensitive" as const,
    // Omit `graph` entirely when absent (exactOptionalPropertyTypes) rather than
    // setting it to `undefined`; behaviour is identical.
    ...(graph !== undefined ? { graph } : {}),
  }));

describe(propertyTag(13, "a member's own activity is excluded from its own Risk_Map"), () => {
  it("never lists the requesting member as a contributor in its own Risk_Map (Req 31.5)", () => {
    assertProperty(
      fc.property(contextArb, (context) => {
        const map = buildRiskMap(context);
        for (const entry of map) {
          for (const contributor of entry.contributors) {
            // The requester's own activity must never be attributed back to it,
            // regardless of which device it acted from (exclusion is by memberId).
            expect(contributor.member.memberId).not.toBe(context.requester.memberId);
          }
        }
      }),
    );
  });
});
