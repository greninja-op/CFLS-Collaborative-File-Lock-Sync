/**
 * Unit tests for cooperative hard-stop enforcement (task 11.4, 11.5; Req 3.5,
 * 14.1, 14.2, 14.3, 14.4). Verifies rejection of edits to a hard-locked path
 * held by another member, self-held-lock allowance, and the offline "manual
 * coordination required" behavior that never claims safety.
 */

import {
  ALL_SOFT_CONFIG,
  buildRiskMap,
  type RepositoryRulesConfig,
} from "@cfls/core-state";
import type { RiskMapEntry } from "@cfls/protocol";
import { describe, expect, it } from "vitest";

import {
  decideEdit,
  enforceHardStop,
  OFFLINE_MANUAL_COORDINATION_MESSAGE,
} from "./hard-stop";
import { buildCoordinationViewModel } from "./view-model";
import type {
  ConnectionSnapshot,
  GetRiskMapData,
  RiskPathEntry,
  StalenessSnapshot,
} from "@cfls/mcp-server";

const online: ConnectionSnapshot = {
  status: "online",
  hostUrl: "h",
  lastSyncAt: "t",
};
const offline: ConnectionSnapshot = {
  status: "offline",
  hostUrl: "h",
  lastSyncAt: null,
};
const fresh: StalenessSnapshot = { stale: false, secondsSinceSync: 0 };
const staleSnap: StalenessSnapshot = { stale: true, secondsSinceSync: null };

const hardRules: RepositoryRulesConfig = {
  version: 1,
  defaults: { mode: "soft" },
  rules: [{ glob: "src/critical/**", mode: "hard" }],
};

describe("decideEdit (Req 14)", () => {
  it("rejects an online edit to a hard path locked by another member", () => {
    const decision = decideEdit({
      path: "src/critical/db.ts",
      selfMemberId: "alice",
      offline: false,
      mode: "hard",
      hardLockHolderMemberId: "bob",
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe("hard-locked");
      expect(decision.holderMemberId).toBe("bob");
      expect(decision.message).toMatch(/bob/);
    }
  });

  it("allows an edit to a hard path whose winning lock is held by self", () => {
    const decision = decideEdit({
      path: "src/critical/db.ts",
      selfMemberId: "alice",
      offline: false,
      mode: "hard",
      hardLockHolderMemberId: "alice",
    });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("no-restriction");
  });

  it("allows a hard path with no winning lock", () => {
    const decision = decideEdit({
      path: "src/critical/db.ts",
      selfMemberId: "alice",
      offline: false,
      mode: "hard",
      hardLockHolderMemberId: null,
    });
    expect(decision.allowed).toBe(true);
  });

  it("does not block a soft path even when contended", () => {
    const decision = decideEdit({
      path: "src/util.ts",
      selfMemberId: "alice",
      offline: false,
      mode: "soft",
      hardLockHolderMemberId: "bob",
    });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("no-restriction");
  });

  it("does not block while offline but reports manual coordination for hard paths (Req 14.4)", () => {
    const decision = decideEdit({
      path: "src/critical/db.ts",
      selfMemberId: "alice",
      offline: true,
      mode: "hard",
      hardLockHolderMemberId: "bob",
    });
    // Never claim safety, but do not block: manual coordination required.
    expect(decision.allowed).toBe(true);
    if (decision.allowed && decision.reason === "offline-manual-coordination") {
      expect(decision.message).toBe(OFFLINE_MANUAL_COORDINATION_MESSAGE);
    } else {
      throw new Error("expected offline-manual-coordination");
    }
  });

  it("allows a soft path offline with no manual-coordination warning", () => {
    const decision = decideEdit({
      path: "src/util.ts",
      selfMemberId: "alice",
      offline: true,
      mode: "soft",
    });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("no-restriction");
  });
});

describe("enforceHardStop over the view model (Req 3.5, 14)", () => {
  function riskMapWithHardLock(holder: string): GetRiskMapData {
    return {
      paths: [
        {
          path: "src/critical/db.ts",
          riskLevel: "hard",
          contributors: [{ memberId: holder, kind: "hard_lock" }],
          explanation: { type: "direct" },
          acknowledgementRequired: false,
        },
      ],
      plannedFileCreations: [],
      highestRevision: 10,
    };
  }

  it("rejects an edit to a hard-locked path held by another member", () => {
    const vm = buildCoordinationViewModel({
      riskMap: riskMapWithHardLock("bob"),
      connection: online,
      staleness: fresh,
    });
    const decision = enforceHardStop(
      vm,
      ALL_SOFT_CONFIG,
      "src/critical/db.ts",
      "alice",
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.holderMemberId).toBe("bob");
    }
  });

  it("uses the rules config to resolve hard mode for a path absent from the view model", () => {
    // No active locks at all, but rules mark the path hard: online with no
    // winning lock => allowed; offline => manual coordination.
    const vmOnline = buildCoordinationViewModel({
      riskMap: { paths: [], plannedFileCreations: [], highestRevision: 0 },
      connection: online,
      staleness: fresh,
    });
    expect(
      enforceHardStop(vmOnline, hardRules, "src/critical/db.ts", "alice")
        .reason,
    ).toBe("no-restriction");

    const vmOffline = buildCoordinationViewModel({
      riskMap: { paths: [], plannedFileCreations: [], highestRevision: 0 },
      connection: offline,
      staleness: staleSnap,
    });
    const decision = enforceHardStop(
      vmOffline,
      hardRules,
      "src/critical/db.ts",
      "alice",
    );
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("offline-manual-coordination");
  });

  it("normalizes the path before resolving the decision", () => {
    const vm = buildCoordinationViewModel({
      riskMap: riskMapWithHardLock("bob"),
      connection: online,
      staleness: fresh,
    });
    // A messy spelling of the same path still resolves to the hard lock.
    const decision = enforceHardStop(
      vm,
      ALL_SOFT_CONFIG,
      "./src/critical/db.ts",
      "alice",
    );
    expect(decision.allowed).toBe(false);
  });
});

/**
 * End-to-end producer↔consumer alignment (regression for the contributor-kind
 * mismatch). Instead of a hand-crafted GetRiskMapData, this drives a REAL
 * `buildRiskMap` from `@cfls/core-state` — exactly what the agent's
 * `get_risk_map` returns — through the view model and hard-stop, so a future
 * drift between the risk producer's contributor `kind` and the extension's
 * buckets is caught here.
 */
describe("enforceHardStop over a REAL buildRiskMap (regression, Req 3.5, 14)", () => {
  /** Map a core-state RiskMapEntry[] into the agent's GetRiskMapData shape. */
  function toRiskMapData(entries: RiskMapEntry[]): GetRiskMapData {
    return {
      paths: entries.map((entry) => {
        const explanation: RiskPathEntry["explanation"] = {
          type: entry.explanation.type,
        };
        if (entry.explanation.edges !== undefined)
          explanation.edges = entry.explanation.edges;
        if (entry.explanation.sharedContracts !== undefined) {
          explanation.sharedContracts = entry.explanation.sharedContracts;
        }
        return {
          path: entry.path,
          riskLevel: entry.riskLevel,
          contributors: entry.contributors.map((c) => ({
            memberId: c.member.memberId,
            kind: c.kind,
          })),
          explanation,
          acknowledgementRequired: entry.acknowledgementRequired,
        };
      }),
      plannedFileCreations: [],
      highestRevision: 1,
    };
  }

  it("blocks an edit to a real hard-locked path held by another member", () => {
    const entries = buildRiskMap({
      requester: { memberId: "alice", deviceId: "alice-1" },
      branch: "main",
      rules: hardRules, // src/critical/** => hard
      locks: [
        {
          lockId: "lk-1",
          scope: "src/critical/db.ts",
          scopeKind: "file",
          mode: "hard",
          holder: { memberId: "bob", deviceId: "bob-1" },
          branch: "main",
          eventRevision: 1,
          acquiredAt: "2024-01-01T00:00:00.000Z",
          concurrent: false,
        },
      ],
      presence: [],
      intents: [],
      sensitivity: "case-sensitive",
    });

    const vm = buildCoordinationViewModel({
      riskMap: toRiskMapData(entries),
      connection: online,
      staleness: fresh,
    });

    // The bug: hardLockMembers was always empty because buildRiskMap emitted
    // kind "lock", not "hard_lock". This asserts they now agree.
    const view = vm.paths.find((p) => p.path === "src/critical/db.ts");
    expect(view?.hardLockMembers).toEqual(["bob"]);

    const decision = enforceHardStop(
      vm,
      hardRules,
      "src/critical/db.ts",
      "alice",
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.holderMemberId).toBe("bob");
    }
  });
});
