/**
 * Unit tests for the pure state→view-model rendering (task 11.3, 11.5; Req 3.3,
 * 3.4, 3.6, 33.3). Verifies per-path lock/presence/intent/planned-creation/
 * indirect-risk projection with contributing member identity, and the
 * offline/stale indicator.
 */

import type {
  ConnectionSnapshot,
  GetRiskMapData,
  StalenessSnapshot,
} from "@cfls/mcp-server";
import { describe, expect, it } from "vitest";

import {
  buildCoordinationViewModel,
  findPathView,
  statusLine,
} from "./view-model";

const online: ConnectionSnapshot = {
  status: "online",
  hostUrl: "wss://host.test:8443",
  lastSyncAt: "2024-01-01T00:00:00.000Z",
};
const offline: ConnectionSnapshot = {
  status: "offline",
  hostUrl: "wss://host.test:8443",
  lastSyncAt: null,
};
const fresh: StalenessSnapshot = { stale: false, secondsSinceSync: 1 };
const staleSnap: StalenessSnapshot = { stale: true, secondsSinceSync: 42 };

const riskMap: GetRiskMapData = {
  paths: [
    {
      path: "src/api.ts",
      riskLevel: "hard",
      contributors: [
        { memberId: "bob", kind: "hard_lock" },
        { memberId: "carol", kind: "presence" },
        { memberId: "bob", kind: "hard_lock" }, // duplicate collapses
      ],
      explanation: { type: "direct" },
      acknowledgementRequired: false,
    },
    {
      path: "src/routes.ts",
      riskLevel: "coordination-required",
      contributors: [
        { memberId: "dave", kind: "coordination_required_lock" },
        { memberId: "erin", kind: "intent" },
        { memberId: "frank", kind: "soft_lock" },
        { memberId: "gina", kind: "dependency" },
      ],
      explanation: {
        type: "indirect",
        edges: [
          {
            from: "src/routes.ts",
            to: "src/api.ts",
            kind: "runtime_import",
            confidence: "high",
          },
        ],
        sharedContracts: ["openapi:orders"],
      },
      acknowledgementRequired: true,
    },
  ],
  plannedFileCreations: [{ path: "src/new.ts", memberId: "bob" }],
  highestRevision: 421,
};

describe("buildCoordinationViewModel (Req 3.4)", () => {
  it("projects per-path locks, presence, intents, and dependency risk by member", () => {
    const vm = buildCoordinationViewModel({
      riskMap,
      connection: online,
      staleness: fresh,
    });

    const api = findPathView(vm, "src/api.ts");
    expect(api?.riskLevel).toBe("hard");
    expect(api?.hardLockMembers).toEqual(["bob"]); // de-duplicated
    expect(api?.presenceMembers).toEqual(["carol"]);
    expect(api?.indirectRisk).toBeNull();

    const routes = findPathView(vm, "src/routes.ts");
    expect(routes?.coordinationRequiredMembers).toEqual(["dave"]);
    expect(routes?.intentMembers).toEqual(["erin"]);
    expect(routes?.softLockMembers).toEqual(["frank"]);
    expect(routes?.dependencyRiskMembers).toEqual(["gina"]);
    expect(routes?.acknowledgementRequired).toBe(true);
  });

  it("surfaces the indirect dependency explanation (Req 3.4, 22)", () => {
    const vm = buildCoordinationViewModel({
      riskMap,
      connection: online,
      staleness: fresh,
    });
    const routes = findPathView(vm, "src/routes.ts");
    expect(routes?.indirectRisk?.edges[0]).toMatchObject({
      from: "src/routes.ts",
      to: "src/api.ts",
      kind: "runtime_import",
    });
    expect(routes?.indirectRisk?.sharedContracts).toEqual(["openapi:orders"]);
  });

  it("surfaces planned file creations with the contributing member", () => {
    const vm = buildCoordinationViewModel({
      riskMap,
      connection: online,
      staleness: fresh,
    });
    expect(vm.plannedFileCreations).toEqual([
      { path: "src/new.ts", memberId: "bob" },
    ]);
  });
});

describe("offline / stale indicator (Req 3.6, 33.3)", () => {
  it("marks the view model offline and stale when the agent is offline", () => {
    const vm = buildCoordinationViewModel({
      riskMap,
      connection: offline,
      staleness: staleSnap,
    });
    expect(vm.offline).toBe(true);
    expect(vm.stale).toBe(true);
    expect(vm.statusText).toMatch(/Offline/);
    expect(vm.statusText).toMatch(/manual coordination/i);
    expect(vm.secondsSinceSync).toBe(42);
  });

  it("reports online when connected and fresh", () => {
    const vm = buildCoordinationViewModel({
      riskMap,
      connection: online,
      staleness: fresh,
    });
    expect(vm.offline).toBe(false);
    expect(vm.stale).toBe(false);
    expect(vm.statusText).toBe("Online");
  });

  it("reports stale when online but data has not synced", () => {
    expect(statusLine(online, staleSnap)).toMatch(/Stale/);
  });
});
