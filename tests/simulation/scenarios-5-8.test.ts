/**
 * Local multi-agent simulation — scenarios 5–8 (task 12.3; design §13.4).
 *
 * One real CoordinationHost + five in-process CoordinationAgents over the real
 * local WSS transport exercise:
 *   5. Lock acquire/release happy path (Req 12.1).
 *   6. Stale lock expiry after missed heartbeats (Req 26.3).
 *   7. Reconnect sync convergence from a known revision (Req 9.4).
 *   8. Unauthorized / revoked-device rejection (Req 5.4).
 */

import { afterEach, describe, expect, it } from "vitest";

import { HostConnection } from "@cfls/agent";
import type { CoordinationUpdate } from "@cfls/protocol";
import { generateDeviceKey } from "@cfls/security";

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

describe("Scenario 5 — lock acquire/release happy path (Req 12.1)", () => {
  it("acquires a lock visible to all agents, then releases it everywhere", async () => {
    sim = await Simulation.start();
    const path = "src/module.ts";

    const acquired = await sim.acquireLock(0, path);
    expect(acquired.granted).toBe(true);
    expect(acquired.lockId).toBeTruthy();

    await sim.waitForConverged((entries) => hasLock(entries, path, "agent-0"), {
      label: "lock acquire convergence",
    });

    const released = await sim.releaseLock(0, path);
    expect(released.released).toBe(true);

    await sim.waitForConverged(
      (entries) => !hasLock(entries, path, "agent-0"),
      { label: "lock release convergence" },
    );

    // The host authority holds no lock on the path after release.
    const snapshot = sim.host.authority.snapshot(sim.session);
    expect(snapshot.locks.filter((l) => l.scope === path)).toHaveLength(0);
  });
});

describe("Scenario 6 — stale lock expiry after missed heartbeats (Req 26.3)", () => {
  it("releases a lock whose holder's heartbeat has gone stale and broadcasts the removal", async () => {
    sim = await Simulation.start();
    const path = "src/stale.ts";
    const holder = sim.agentAt(0);

    await sim.acquireLock(0, path);
    await sim.waitForConverged((entries) => hasLock(entries, path, "agent-0"), {
      label: "pre-expiry convergence",
    });

    // Authentication records an initial liveness heartbeat.  Advance the
    // deterministic sweep clock from the current epoch instead of attempting
    // to overwrite that newer receipt with an old synthetic timestamp: the
    // expiry engine intentionally ignores out-of-order heartbeats.
    //
    // No wall-clock waiting is involved; only the sweep's supplied time moves
    // forward past the Lock_Expiry_Interval.
    const t0 = Date.now() + 1;
    sim.host.authority.recordHeartbeat(sim.session, holder.member.deviceId, t0);
    const removals = sim.host.authority.sweepExpiry(
      sim.session,
      t0 + 10 * 60_000,
    );

    expect(removals.length).toBeGreaterThan(0);
    expect(removals.some((r) => r.op === "removed" && r.path === path)).toBe(
      true,
    );

    // Broadcast the authoritative removals over the real transport (as the
    // host's periodic sweep would) and confirm every agent drops the lock.
    for (const update of removals) {
      sim.host.server.broadcast(sim.session, update);
    }
    await sim.waitForConverged(
      (entries) => !hasLock(entries, path, "agent-0"),
      { label: "expiry convergence" },
    );

    expect(
      sim.host.authority
        .snapshot(sim.session)
        .locks.filter((l) => l.scope === path),
    ).toHaveLength(0);
  });
});

describe("Scenario 7 — reconnect sync convergence from a known revision (Req 9.4)", () => {
  it("converges a reconnecting agent to events it missed while offline", async () => {
    sim = await Simulation.start();
    const before = "src/before.ts";
    const missed = "src/missed.ts";
    const reconnecting = sim.agentAt(1);

    // A first lock everyone (including agent-1) sees.
    await sim.acquireLock(0, before);
    await sim.waitForConverged(
      (entries) => hasLock(entries, before, "agent-0"),
      { label: "baseline convergence" },
    );

    const knownRevision = reconnecting.agent.view.highestApplied(sim.session);
    expect(knownRevision).toBeGreaterThan(0);

    // Drop agent-1's connection (transient network loss) and confirm it is offline.
    reconnecting.agent.hostConnection().simulateDrop();
    await sim.waitUntil(
      () => reconnecting.agent.hostConnection().connectionState() === "offline",
      { label: "agent-1 offline" },
    );

    // While agent-1 is offline, agent-0 acquires another lock it cannot see yet.
    await sim.acquireLock(0, missed);
    await sim.waitUntil(() => hasLock(sim!.entries(0), missed, "agent-0"), {
      label: "missed lock recorded on host",
    });
    expect(hasLock(sim.entries(1), missed, "agent-0")).toBe(false);

    // Reconnect: the agent syncs from its known revision and converges.
    await reconnecting.agent.hostConnection().connect();
    await sim.waitUntil(
      () =>
        hasLock(sim!.entries(1), before, "agent-0") &&
        hasLock(sim!.entries(1), missed, "agent-0"),
      { label: "reconnect sync convergence" },
    );

    // Converged strictly above the revision it reconnected from (Req 9.1, 9.4).
    expect(reconnecting.agent.view.highestApplied(sim.session)).toBeGreaterThan(
      knownRevision,
    );
  });
});

describe("Scenario 8 — unauthorized / revoked-device rejection (Req 5.4)", () => {
  it("rejects a device whose invitation is not signed by an admin", async () => {
    sim = await Simulation.start();

    const rogue = generateDeviceKey();
    const nonAdminIssuer = generateDeviceKey();
    // Invitation signed by a non-admin issuer — must not admit the device.
    const forgedInvitation = sim.invitationFor(rogue, "rogue", nonAdminIssuer);

    const conn = new HostConnection({
      hostUrl: sim.hostUrl,
      session: sim.session,
      deviceKey: rogue,
      invitation: forgedInvitation,
      insecureTls: true,
      autoReconnect: false,
      heartbeatIntervalMs: 0,
    });

    await expect(conn.connect()).rejects.toThrow(/AUTH_/);
    conn.close();
  });

  it("rejects a device after its key is revoked (Req 5.6)", async () => {
    sim = await Simulation.start();

    const device = generateDeviceKey();
    const invitation = sim.invitationFor(device, "temp-member");

    // First admission over the real handshake succeeds and records membership.
    const first = new HostConnection({
      hostUrl: sim.hostUrl,
      session: sim.session,
      deviceKey: device,
      invitation,
      insecureTls: true,
      autoReconnect: false,
      heartbeatIntervalMs: 0,
    });
    await first.connect();
    expect(first.isOnline()).toBe(true);
    first.close();

    // Revoke the device on the host authority.
    sim.host.authority.revoke(sim.session, device.publicKey);

    // A fresh connection with the same (still well-formed) invitation is rejected.
    const second = new HostConnection({
      hostUrl: sim.hostUrl,
      session: sim.session,
      deviceKey: device,
      invitation,
      insecureTls: true,
      autoReconnect: false,
      heartbeatIntervalMs: 0,
    });
    await expect(second.connect()).rejects.toThrow(/AUTH_INVALID_DEVICE/);
    second.close();
  });
});
