/**
 * Local multi-agent simulation — scenarios 9–10 (Req 30, 19, 20).
 *
 * One real CoordinationHost + five in-process CoordinationAgents over the real
 * local WSS transport exercise the coordination paths that were previously
 * accepted-but-not-applied by the host:
 *   9.  Path rename — a soft lock follows a renamed/moved file to its new path
 *       across the whole cluster (Req 30.1, 30.2), and a delete releases it.
 *   10. Dependency-graph distribution — one agent uploads a metadata-only graph,
 *       the host persists it and shares it with the rest of the session, and a
 *       peer that never had a local graph can answer dependency queries (Req 19,
 *       20, 23.2).
 */

import { afterEach, describe, expect, it } from "vitest";

import type { CoordinationUpdate, DependencyGraph } from "@cfls/protocol";

import { Simulation } from "./harness";

let sim: Simulation | undefined;

afterEach(async () => {
  await sim?.stop();
  sim = undefined;
});

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

describe("Scenario 9 — a lock follows a renamed file across the cluster (Req 30.2)", () => {
  it("moves the winning lock from the old path to the new path everywhere, then releases on delete", async () => {
    sim = await Simulation.start();
    const from = "src/old-name.ts";
    const to = "src/new-name.ts";

    await sim.acquireLock(0, from);
    await sim.waitForConverged((entries) => hasLock(entries, from, "agent-0"), {
      label: "pre-rename lock convergence",
    });

    // agent-0 renames the file it holds a lock on.
    sim.renamePath(0, from, to);
    await sim.waitForConverged(
      (entries) =>
        hasLock(entries, to, "agent-0") && !hasLock(entries, from, "agent-0"),
      { label: "rename lock-follow convergence" },
    );

    // The host authority agrees the lock now covers the new path only.
    const locks = sim.host.authority.snapshot(sim.session).locks;
    expect(locks.map((l) => l.scope)).toContain(to);
    expect(locks.map((l) => l.scope)).not.toContain(from);

    // Deleting the renamed file releases the lock everywhere (Req 30.5).
    sim.deletePath(0, to);
    await sim.waitForConverged((entries) => !hasLock(entries, to, "agent-0"), {
      label: "delete release convergence",
    });
    expect(
      sim.host.authority
        .snapshot(sim.session)
        .locks.filter((l) => l.scope === to),
    ).toHaveLength(0);
  });
});

describe("Scenario 10 — dependency-graph upload is shared across the session (Req 19, 20)", () => {
  it("distributes an uploaded graph to peers so they can answer dependency queries", async () => {
    sim = await Simulation.start();
    const graph: DependencyGraph = {
      snapshot: {
        sessionId: sim.session,
        graphVersion: 1,
        analyzerVersion: "sim",
      },
      packages: [],
      modules: [
        {
          sourceFile: "src/a.ts",
          edges: [
            {
              from: "src/a.ts",
              to: "src/b.ts",
              kind: "runtime_import",
              confidence: "high",
            },
          ],
        },
      ],
      contracts: [],
    };

    // agent-0 uploads the graph; the host persists and fans it out to peers.
    sim.uploadGraph(0, graph);

    // agent-1 never had a local graph — it must receive the shared one.
    await sim.waitUntil(() => sim!.portGraph(1) !== undefined, {
      label: "graph distribution to peer",
    });

    // The host holds the graph, and the peer can answer a dependency query
    // purely from the shared graph (Req 23.2).
    expect(sim.host.authority.dependencyGraph(sim.session)).not.toBeNull();
    const deps = await sim.getDependencies(1, "src/a.ts");
    expect(deps.presentInGraph).toBe(true);
    expect(deps.dependsOn).toContain("src/b.ts");
  });
});
