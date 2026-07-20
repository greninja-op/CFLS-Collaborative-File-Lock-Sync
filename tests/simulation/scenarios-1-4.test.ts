/**
 * Local multi-agent simulation — scenarios 1–4 (task 12.2; design §13.4).
 *
 * One real CoordinationHost + five in-process CoordinationAgents over the real
 * local WSS transport exercise:
 *   1. Presence propagation to peers (Req 11.1).
 *   2. Declared-intent broadcast and reconciliation with saves (Req 17.1).
 *   3. Direct conflict on the same path — deterministic winner by earliest
 *      Event_Revision (Req 21.1).
 *   4. Indirect dependency conflict via a Dependency_Edge — two agents changing
 *      dependency-linked paths both see indirect risk (Req 22.1).
 */

import { afterEach, describe, expect, it } from "vitest";

import type {
  CoordinationUpdate,
  DependencyGraph,
  SessionId,
} from "@cfls/protocol";

import { Simulation } from "./harness";

let sim: Simulation | undefined;

afterEach(async () => {
  await sim?.stop();
  sim = undefined;
});

/** Does an agent's view hold an active `presence` entry for `path` by `memberId`? */
function hasPresence(
  entries: CoordinationUpdate[],
  path: string,
  memberId: string,
): boolean {
  return entries.some(
    (e) =>
      e.entryType === "presence" &&
      e.path === path &&
      e.member.memberId === memberId,
  );
}

/** Does an agent's view hold an active `intent` entry for `path` by `memberId`? */
function hasIntent(
  entries: CoordinationUpdate[],
  path: string,
  memberId: string,
): boolean {
  return entries.some(
    (e) =>
      e.entryType === "intent" &&
      e.path === path &&
      e.member.memberId === memberId,
  );
}

/** Does an agent's view hold a `soft_lock` for `path` won by `memberId`? */
function hasLock(
  entries: CoordinationUpdate[],
  path: string,
  memberId: string,
): boolean {
  return entries.some(
    (e) =>
      e.entryType === "soft_lock" &&
      e.path === path &&
      e.member.memberId === memberId,
  );
}

describe("Scenario 1 — presence propagation to peers (Req 11.1)", () => {
  it("propagates one agent's editing presence to all five agents", async () => {
    sim = await Simulation.start();
    const path = "src/app.ts";

    sim.reportPresence(0, path, "editing");

    await sim.waitForConverged(
      (entries) => hasPresence(entries, path, "agent-0"),
      { label: "presence propagation" },
    );

    // Every agent — including peers who never touched the file — sees it.
    for (let i = 0; i < sim.agents.length; i += 1) {
      expect(hasPresence(sim.entries(i), path, "agent-0")).toBe(true);
    }

    // A `stopped` presence retracts the entry everywhere (end-of-presence).
    sim.reportPresence(0, path, "stopped");
    await sim.waitForConverged(
      (entries) => !hasPresence(entries, path, "agent-0"),
      { label: "presence retraction" },
    );
  });
});

describe("Scenario 2 — declared intent broadcast + reconciliation with saves (Req 17.1)", () => {
  it("broadcasts a declared intent to peers and reconciles a subsequent save", async () => {
    sim = await Simulation.start();
    const path = "src/service.ts";

    const declared = await sim.declareIntent(0, {
      modifyPaths: [path],
      description: "refactor the service layer",
    });
    expect(declared.eventRevision).toBeGreaterThan(0);

    // The intent reaches every peer.
    await sim.waitForConverged(
      (entries) => hasIntent(entries, path, "agent-0"),
      { label: "intent broadcast" },
    );

    // The real save (editor event) reconciles into presence on the same path,
    // observed alongside the still-active intent (Req 17.1, 17.5).
    sim.save(0, path);
    await sim.waitForConverged(
      (entries) =>
        hasIntent(entries, path, "agent-0") &&
        hasPresence(entries, path, "agent-0"),
      { label: "save reconciliation" },
    );

    for (let i = 1; i < sim.agents.length; i += 1) {
      expect(hasIntent(sim.entries(i), path, "agent-0")).toBe(true);
      expect(hasPresence(sim.entries(i), path, "agent-0")).toBe(true);
    }
  });
});

describe("Scenario 3 — direct conflict, deterministic winner by revision (Req 21.1, 8.2)", () => {
  it("awards a contested path to the earliest Event_Revision and reports the loser's concurrent claim", async () => {
    sim = await Simulation.start();
    const path = "src/conflict.ts";

    // agent-0 acquires first → earliest revision → the deterministic winner.
    const first = await sim.acquireLock(0, path);
    expect(first.granted).toBe(true);
    const winningRevision = first.eventRevision;

    // agent-1 contends for the same path → loses to the earlier revision.
    const second = await sim.acquireLock(1, path);
    expect(second.granted).toBe(false);
    expect(second.concurrentClaim).toBe(true);
    expect(second.winner?.memberId).toBe("agent-0");

    // The whole cluster converges on agent-0 as the single holder.
    await sim.waitForConverged(
      (entries) =>
        hasLock(entries, path, "agent-0") && !hasLock(entries, path, "agent-1"),
      { label: "conflict convergence" },
    );

    // The host authority agrees: agent-0's is the winning (non-concurrent) lock,
    // and it is the earliest-revision claim.
    const snapshot = sim.host.authority.snapshot(sim.session);
    const winners = snapshot.locks.filter(
      (l) => l.scope === path && !l.concurrent,
    );
    expect(winners).toHaveLength(1);
    expect(winners[0]?.holder.memberId).toBe("agent-0");
    expect(winners[0]?.eventRevision).toBe(winningRevision);
  });
});

describe("Scenario 4 — indirect dependency conflict via a Dependency_Edge (Req 22.1)", () => {
  it("flags an indirect dependency risk for both agents changing dependency-linked paths", async () => {
    // Dependency chain: x -> y -> z (x depends on y, y depends on z). Two agents
    // change the endpoints (x and z); the shared middle module y surfaces as an
    // indirect dependency risk for BOTH of them (forward for the x-changer,
    // reverse for the z-changer).
    const X = "src/x.ts";
    const Y = "src/y.ts";
    const Z = "src/z.ts";
    const graphSession: SessionId = {
      repoId: "github.com/acme/coordination",
      teamId: "team-sim",
      branch: "main",
      baseRevision: null,
    };
    const graph: DependencyGraph = {
      snapshot: {
        sessionId: graphSession,
        graphVersion: 1,
        analyzerVersion: "sim",
      },
      packages: [],
      modules: [
        {
          sourceFile: X,
          edges: [
            { from: X, to: Y, kind: "runtime_import", confidence: "high" },
          ],
        },
        {
          sourceFile: Y,
          edges: [
            { from: Y, to: Z, kind: "runtime_import", confidence: "high" },
          ],
        },
      ],
      contracts: [],
    };

    sim = await Simulation.start({ graph });

    await sim.acquireLock(0, X);
    await sim.acquireLock(1, Z);

    // Both agents' views must include the other's lock before risk is projected.
    await sim.waitUntil(
      () =>
        hasLock(sim!.entries(0), Z, "agent-1") &&
        hasLock(sim!.entries(1), X, "agent-0"),
      { label: "cross-agent lock visibility" },
    );

    // agent-0 changed x; the middle module y is an indirect forward-dependency
    // risk contributed by agent-1 (who changed z).
    const riskFor0 = await sim.getRiskMap(0);
    const y0 = riskFor0.paths.find((p) => p.path === Y);
    expect(y0).toBeDefined();
    expect(y0?.explanation.type).toBe("indirect");
    expect(y0?.contributors.map((c) => c.memberId)).toContain("agent-1");

    // agent-1 changed z; y is an indirect reverse-dependency risk contributed by
    // agent-0 (who changed x).
    const riskFor1 = await sim.getRiskMap(1);
    const y1 = riskFor1.paths.find((p) => p.path === Y);
    expect(y1).toBeDefined();
    expect(y1?.explanation.type).toBe("indirect");
    expect(y1?.contributors.map((c) => c.memberId)).toContain("agent-0");

    // The contributing edge (with its confidence) travels with the risk (Req 22.4).
    expect(y0?.explanation.edges?.some((e) => e.confidence === "high")).toBe(
      true,
    );
  });
});
