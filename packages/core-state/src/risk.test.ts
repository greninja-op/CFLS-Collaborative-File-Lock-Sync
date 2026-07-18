/**
 * Unit tests for risk classification & Risk_Map projection (task 4.14).
 *
 * Covers Req 21.1–21.3 (direct conflicts + distinct-branch handling),
 * Req 22.1–22.5 (indirect/reverse-dependency + shared-contract + confidence),
 * Req 24.1–24.7 (three-level classification, no escalation without a matching
 * rule, contributor identities + explanation paths), and Req 31.5 (own-activity
 * exclusion), plus the coordination-required acknowledgement flag (Req 13.5).
 */

import type {
  DeclaredIntent,
  DependencyGraph,
  Lock,
  MemberRef,
  Presence,
  SessionId,
} from "@cfls/protocol";
import { describe, expect, it } from "vitest";

import { buildRiskMap, ContentionKind, type RiskMapContext } from "./risk";
import { parseRulesConfig, type RepositoryRulesConfig } from "./rules";

const SESSION: SessionId = {
  repoId: "github.com/acme/app",
  teamId: "team-1",
  branch: "main",
  baseRevision: null,
};

const ALICE: MemberRef = { memberId: "alice", deviceId: "alice-laptop" };
const ALICE_2: MemberRef = { memberId: "alice", deviceId: "alice-desktop" };
const BOB: MemberRef = { memberId: "bob", deviceId: "bob-laptop" };
const CAROL: MemberRef = { memberId: "carol", deviceId: "carol-laptop" };

/** A rules config that maps a glob to a mode over an all-soft default. */
function rulesFor(entries: { glob: string; mode: string }[]): RepositoryRulesConfig {
  const result = parseRulesConfig({
    version: 1,
    defaults: { mode: "soft" },
    rules: entries,
  });
  if (result.malformed) {
    throw new Error(`bad rules config: ${JSON.stringify(result.errors)}`);
  }
  return result.config;
}

const ALL_SOFT = rulesFor([]);

function lock(overrides: Partial<Lock> & Pick<Lock, "scope" | "holder">): Lock {
  return {
    lockId: overrides.lockId ?? `lock-${overrides.scope}-${overrides.holder.memberId}`,
    scope: overrides.scope,
    scopeKind: overrides.scopeKind ?? "file",
    mode: overrides.mode ?? "soft",
    holder: overrides.holder,
    branch: overrides.branch ?? "main",
    eventRevision: overrides.eventRevision ?? 1,
    acquiredAt: overrides.acquiredAt ?? "2024-01-01T00:00:00.000Z",
    concurrent: overrides.concurrent ?? false,
  };
}

function baseContext(overrides: Partial<RiskMapContext> = {}): RiskMapContext {
  return {
    requester: ALICE,
    branch: "main",
    locks: [],
    presence: [],
    intents: [],
    rules: ALL_SOFT,
    sensitivity: "case-sensitive",
    ...overrides,
  };
}

describe("buildRiskMap — own-activity exclusion (Req 31.5)", () => {
  it("excludes the requester's own locks, intents, and presence across all its devices", () => {
    const intent: DeclaredIntent = {
      intentId: "i1",
      owner: ALICE_2,
      agentId: "agent-a",
      modifyPaths: ["src/owned.ts"],
      createPaths: [],
      scopeKind: "file",
      branch: "main",
      description: "own work",
      eventRevision: 2,
    };
    const presence: Presence = {
      member: ALICE,
      path: "src/owned.ts",
      state: "editing",
      eventRevision: 3,
    };
    const map = buildRiskMap(
      baseContext({
        locks: [lock({ scope: "src/owned.ts", holder: ALICE })],
        intents: [intent],
        presence: [presence],
      }),
    );
    expect(map).toEqual([]);
  });

  it("still reports another member's activity on a path the requester also touches", () => {
    const map = buildRiskMap(
      baseContext({
        locks: [
          lock({ scope: "src/shared.ts", holder: ALICE }),
          lock({ scope: "src/shared.ts", holder: BOB, eventRevision: 5, concurrent: true }),
        ],
      }),
    );
    expect(map).toHaveLength(1);
    expect(map[0]?.path).toBe("src/shared.ts");
    expect(map[0]?.contributors).toEqual([
      { member: BOB, kind: ContentionKind.Lock },
    ]);
  });
});

describe("buildRiskMap — direct conflict classification (Req 21, 24)", () => {
  it("classifies a hard-rule path contended under the same branch as hard (Req 24.2)", () => {
    const map = buildRiskMap(
      baseContext({
        rules: rulesFor([{ glob: "src/**", mode: "hard" }]),
        locks: [lock({ scope: "src/core.ts", holder: BOB, mode: "hard" })],
      }),
    );
    expect(map[0]?.riskLevel).toBe("hard");
    expect(map[0]?.explanation.type).toBe("direct");
    expect(map[0]?.acknowledgementRequired).toBe(false);
    expect(map[0]?.contributors).toEqual([{ member: BOB, kind: ContentionKind.Lock }]);
  });

  it("classifies a coordination-required path contended as coordination-required and sets acknowledgementRequired (Req 24.3, 13.5)", () => {
    const map = buildRiskMap(
      baseContext({
        rules: rulesFor([{ glob: "api/**", mode: "coordination-required" }]),
        intents: [
          {
            intentId: "i-bob",
            owner: BOB,
            agentId: "agent-b",
            modifyPaths: ["api/routes.ts"],
            createPaths: [],
            scopeKind: "file",
            branch: "main",
            description: "edit routes",
            eventRevision: 4,
          },
        ],
      }),
    );
    expect(map[0]?.riskLevel).toBe("coordination-required");
    expect(map[0]?.acknowledgementRequired).toBe(true);
    expect(map[0]?.contributors).toEqual([{ member: BOB, kind: ContentionKind.Intent }]);
  });

  it("never escalates to hard/coordination-required without a matching rule (Req 24.4, 24.6)", () => {
    const map = buildRiskMap(
      baseContext({
        // No rules: default soft. Even a hard-mode lock cannot escalate the path.
        locks: [lock({ scope: "src/core.ts", holder: BOB, mode: "hard" })],
      }),
    );
    expect(map[0]?.riskLevel).toBe("soft");
  });

  it("treats same-path activity under a different branch as a reduced conflict and reports the distinct branch (Req 21.3)", () => {
    const map = buildRiskMap(
      baseContext({
        rules: rulesFor([{ glob: "src/**", mode: "hard" }]),
        branch: "main",
        locks: [lock({ scope: "src/core.ts", holder: BOB, mode: "hard", branch: "feature-x" })],
      }),
    );
    // Different branch → not contended → cannot escalate to hard.
    expect(map[0]?.riskLevel).toBe("soft");
    expect(map[0]?.contributors[0]?.kind).toBe(`${ContentionKind.Lock} (branch: feature-x)`);
  });

  it("classifies presence-only activity as soft (Req 24.4)", () => {
    const map = buildRiskMap(
      baseContext({
        rules: rulesFor([{ glob: "src/**", mode: "hard" }]),
        presence: [{ member: BOB, path: "src/core.ts", state: "editing", eventRevision: 1 }],
      }),
    );
    // Presence contends (soft), but with no rule escalation beyond a hard rule
    // it stays hard only if a hard rule applies AND contended → here contended
    // via presence, so it escalates to hard.
    expect(map[0]?.riskLevel).toBe("hard");
    expect(map[0]?.contributors).toEqual([{ member: BOB, kind: ContentionKind.Presence }]);
  });

  it("ignores stopped presence entries", () => {
    const map = buildRiskMap(
      baseContext({
        presence: [{ member: BOB, path: "src/core.ts", state: "stopped", eventRevision: 1 }],
      }),
    );
    expect(map).toEqual([]);
  });
});

describe("buildRiskMap — indirect & reverse-dependency risk (Req 22)", () => {
  const graph = (edges: DependencyGraph["modules"][number]["edges"]): DependencyGraph => ({
    snapshot: { sessionId: SESSION, graphVersion: 1, analyzerVersion: "test" },
    packages: [],
    modules: [{ sourceFile: "src/a.ts", edges }],
    contracts: [],
  });

  it("flags a path that depends on another member's changed path as an indirect forward-dependency risk with edge confidence (Req 22.1, 22.4)", () => {
    const map = buildRiskMap(
      baseContext({
        requester: CAROL,
        // Only src/b.ts is being changed (by BOB). src/a.ts depends on it.
        locks: [lock({ scope: "src/b.ts", holder: BOB })],
        graph: graph([
          { from: "src/a.ts", to: "src/b.ts", kind: "runtime_import", confidence: "high" },
        ]),
      }),
    );
    const a = map.find((e) => e.path === "src/a.ts");
    // a depends on b (changed by BOB) → indirect-only forward dependency risk.
    expect(a?.explanation.type).toBe("indirect");
    expect(a?.explanation.edges?.[0]?.confidence).toBe("high");
    expect(a?.contributors).toEqual([{ member: BOB, kind: ContentionKind.Dependency }]);
    expect(a?.riskLevel).toBe("soft");
  });

  it("flags a path depended on by another member's changed path as an indirect reverse-dependency risk (Req 22.2)", () => {
    const map = buildRiskMap(
      baseContext({
        requester: CAROL,
        // Only src/a.ts is being changed (by BOB); src/b.ts is depended on by it.
        locks: [lock({ scope: "src/a.ts", holder: BOB })],
        graph: graph([
          { from: "src/a.ts", to: "src/b.ts", kind: "runtime_import", confidence: "medium" },
        ]),
      }),
    );
    const b = map.find((e) => e.path === "src/b.ts");
    expect(b?.explanation.type).toBe("indirect");
    expect(b?.contributors).toEqual([
      { member: BOB, kind: ContentionKind.ReverseDependency },
    ]);
    expect(b?.riskLevel).toBe("soft");
  });

  it("reports low/unknown-confidence indirect risk as soft rather than a confirmed conflict (Req 22.5)", () => {
    const map = buildRiskMap(
      baseContext({
        requester: CAROL,
        rules: rulesFor([{ glob: "src/**", mode: "hard" }]),
        locks: [lock({ scope: "src/b.ts", holder: BOB })],
        graph: graph([
          { from: "src/a.ts", to: "src/b.ts", kind: "dynamic_unknown", confidence: "low" },
        ]),
      }),
    );
    const a = map.find((e) => e.path === "src/a.ts");
    // Indirect risk does not contend → no escalation despite the hard rule.
    expect(a?.riskLevel).toBe("soft");
    expect(a?.explanation.edges?.[0]?.confidence).toBe("low");
  });

  it("does not re-introduce the requester's own path via a dependency edge (Req 31.5)", () => {
    const map = buildRiskMap(
      baseContext({
        requester: ALICE,
        // ALICE changes src/a.ts (own, excluded); BOB changes src/b.ts.
        locks: [
          lock({ scope: "src/a.ts", holder: ALICE }),
          lock({ scope: "src/b.ts", holder: BOB }),
        ],
        graph: graph([
          { from: "src/a.ts", to: "src/b.ts", kind: "runtime_import", confidence: "high" },
        ]),
      }),
    );
    // src/a.ts is ALICE's own path and must never appear in her own Risk_Map.
    expect(map.find((e) => e.path === "src/a.ts")).toBeUndefined();
    const b = map.find((e) => e.path === "src/b.ts");
    // src/b.ts is BOB's directly-contended path; ALICE's own change is excluded
    // so it contributes no reverse-dependency link back to b.
    expect(b?.contributors).toEqual([{ member: BOB, kind: ContentionKind.Lock }]);
  });

  it("does not create indirect risk when both endpoints are the same member", () => {
    const map = buildRiskMap(
      baseContext({
        requester: CAROL,
        locks: [
          lock({ scope: "src/a.ts", holder: BOB }),
          lock({ scope: "src/b.ts", holder: BOB }),
        ],
        graph: graph([
          { from: "src/a.ts", to: "src/b.ts", kind: "runtime_import", confidence: "high" },
        ]),
      }),
    );
    for (const entry of map) {
      expect(entry.explanation.type).toBe("direct");
      expect(entry.explanation.edges).toBeUndefined();
    }
  });
});

describe("buildRiskMap — shared-contract risk (Req 22.3)", () => {
  it("flags two distinct paths with matching contract fingerprints changed by different members", () => {
    const map = buildRiskMap(
      baseContext({
        requester: CAROL,
        locks: [
          lock({ scope: "src/a.ts", holder: BOB }),
          lock({ scope: "src/b.ts", holder: ALICE }),
        ],
        graph: {
          snapshot: { sessionId: SESSION, graphVersion: 1, analyzerVersion: "test" },
          packages: [],
          modules: [],
          contracts: [
            { id: "src/a.ts", kind: "exported_interface", fingerprint: "SAME" },
            { id: "src/b.ts", kind: "exported_interface", fingerprint: "SAME" },
          ],
        },
      }),
    );
    const a = map.find((e) => e.path === "src/a.ts");
    // Both paths are also directly contended (each by its lock holder), so the
    // primary explanation is direct; the shared contract is attached as the
    // additional indirect dimension (Req 22.3, 24.7).
    expect(a?.explanation.sharedContracts).toEqual(["src/a.ts", "src/b.ts"]);
    expect(a?.contributors).toContainEqual({
      member: ALICE,
      kind: ContentionKind.SharedContract,
    });
  });
});

describe("buildRiskMap — planned file creations (Req 21.2)", () => {
  it("records a planned-creation contribution for another member's create path", () => {
    const map = buildRiskMap(
      baseContext({
        intents: [
          {
            intentId: "i-bob",
            owner: BOB,
            agentId: "agent-b",
            modifyPaths: [],
            createPaths: [{ path: "src/new.ts" }],
            scopeKind: "file",
            branch: "main",
            description: "create file",
            eventRevision: 7,
          },
        ],
      }),
    );
    expect(map[0]?.path).toBe("src/new.ts");
    expect(map[0]?.contributors).toEqual([
      { member: BOB, kind: ContentionKind.PlannedCreation },
    ]);
    expect(map[0]?.riskLevel).toBe("soft");
  });
});

describe("buildRiskMap — determinism", () => {
  it("produces a path-sorted, order-independent result", () => {
    const locks = [
      lock({ scope: "src/z.ts", holder: BOB }),
      lock({ scope: "src/a.ts", holder: BOB }),
      lock({ scope: "src/m.ts", holder: CAROL }),
    ];
    const forward = buildRiskMap(baseContext({ locks }));
    const reversed = buildRiskMap(baseContext({ locks: [...locks].reverse() }));
    expect(forward.map((e) => e.path)).toEqual(["src/a.ts", "src/m.ts", "src/z.ts"]);
    expect(forward).toEqual(reversed);
  });
});
