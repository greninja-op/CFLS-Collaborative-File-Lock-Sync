/**
 * Integration tests for the agent's WSS connection lifecycle over a real host
 * (task 9.8; Req 2.5, 6.4, 6.6, 9.4). Exercises connect → acquire (host records
 * it), Offline_State + OFFLINE_QUEUED while disconnected, and reconnect
 * sync-from-revision convergence with re-assert of held locks.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ALL_SOFT_CONFIG } from "@cfls/core-state";
import type { MemberRef, SessionId } from "@cfls/protocol";
import { deriveDeviceId } from "@cfls/security";
import type { RunningHost } from "@cfls/host";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CoordinationAgent } from "../src/agent";
import {
  invitationFor,
  makeDevice,
  makeSession,
  startDevHost,
  waitUntil,
  type TestDevice,
} from "./support";

const session: SessionId = makeSession();

let host: RunningHost;
let admin: TestDevice;
let cacheDir: string;
let agents: CoordinationAgent[];

function selfOf(device: TestDevice): MemberRef {
  return {
    memberId: device.memberId,
    deviceId: deriveDeviceId(device.key.publicKey),
  };
}

async function startAgent(
  device: TestDevice,
  overrides: { autoReconnect?: boolean } = {},
): Promise<CoordinationAgent> {
  const agent = new CoordinationAgent({
    session,
    self: selfOf(device),
    hostUrl: `wss://127.0.0.1:${host.port}`,
    invitation: invitationFor(session, admin.key, device),
    rules: ALL_SOFT_CONFIG,
    cacheDir,
    deviceKey: device.key,
    insecureTls: true,
    localApiPort: 0,
    enableNamedPipe: false,
    connection: {
      heartbeatIntervalMs: 0,
      autoReconnect: overrides.autoReconnect ?? true,
      backoff: { baseMs: 100, maxMs: 300 },
    },
  });
  agents.push(agent);
  await agent.start();
  return agent;
}

beforeEach(async () => {
  cacheDir = mkdtempSync(join(tmpdir(), "cfls-agent-"));
  admin = makeDevice("admin");
  host = await startDevHost();
  host.authority.registerSession(session, [admin.key.publicKey]);
  agents = [];
});

afterEach(async () => {
  for (const agent of agents) {
    await agent.stop();
  }
  await host.stop();
  rmSync(cacheDir, { recursive: true, force: true });
});

describe("connect + acquire (Req 6.1, 8.1)", () => {
  it("connects, acquires a lock, and the host records it", async () => {
    const agent = await startAgent(admin);
    await waitUntil(() => agent.hostConnection().isOnline());

    const result = await agent.agentPort().acquireLock({
      session,
      scope: "src/api.ts",
      scopeKind: "file",
    });
    expect(result.ok).toBe(true);

    await waitUntil(() =>
      agent.view.entries(session).some((e) => e.path === "src/api.ts"),
    );
    const locks = host.authority.snapshot(session).locks.map((l) => l.scope);
    expect(locks).toContain("src/api.ts");
  });
});

describe("Offline_State (Req 6.4, 33.1)", () => {
  it("refuses mutations with OFFLINE_QUEUED and serves a stale view while offline", async () => {
    const agent = await startAgent(admin, { autoReconnect: false });
    await waitUntil(() => agent.hostConnection().isOnline());

    agent.hostConnection().simulateDrop();
    await waitUntil(() => !agent.hostConnection().isOnline());

    expect(agent.view.isStale()).toBe(true);

    // A mutation while offline must be refused, never falsely accepted (Req 4.8).
    const mutation = await agent.agentPort().acquireLock({
      session,
      scope: "src/x.ts",
      scopeKind: "file",
    });
    expect(mutation.ok).toBe(false);
    if (!mutation.ok) {
      expect(mutation.error.code).toBe("OFFLINE_QUEUED");
    }

    // Queries still succeed (stale-marked) while offline (Req 33.1).
    const risk = agent.agentPort().getRiskMap({ session });
    expect(risk.ok).toBe(true);
    expect(agent.agentPort().getStaleness().stale).toBe(true);
  });
});

describe("reconnect sync-from-revision convergence (Req 9.4, 6.6)", () => {
  it("reconnects after a transient drop and converges the cached view", async () => {
    const agent = await startAgent(admin, { autoReconnect: true });
    await waitUntil(() => agent.hostConnection().isOnline());

    let onlineCount = 0;
    agent.hostConnection().on("online", () => {
      onlineCount += 1;
    });

    await agent
      .agentPort()
      .acquireLock({ session, scope: "src/api.ts", scopeKind: "file" });
    await waitUntil(() =>
      agent.view.entries(session).some((e) => e.path === "src/api.ts"),
    );

    // Transient network drop → the connection auto-reconnects with backoff.
    agent.hostConnection().simulateDrop();
    await waitUntil(() => onlineCount >= 1, 6000);

    // After reconnect the agent re-syncs and re-asserts its held lock; the
    // cached view converges to the authoritative host state and clears staleness.
    await waitUntil(() => !agent.view.isStale(), 6000);
    await waitUntil(
      () =>
        agent.view.highestApplied(session) ===
        host.authority.snapshot(session).highestRevision,
      6000,
    );

    expect(
      agent.view.entries(session).some((e) => e.path === "src/api.ts"),
    ).toBe(true);
    expect(
      host.authority.snapshot(session).locks.map((l) => l.scope),
    ).toContain("src/api.ts");
  });
});
