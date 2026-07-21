/**
 * Live member-roster integration coverage. The host broadcasts membership on
 * authenticated connect/disconnect, and the local MCP port must never invent
 * stale peer connectivity while its own transport is offline.
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
  label: string,
): Promise<CoordinationAgent> {
  const agent = new CoordinationAgent({
    session,
    self: selfOf(device),
    hostUrl: `wss://127.0.0.1:${host.port}`,
    invitation: invitationFor(session, admin.key, device),
    rules: ALL_SOFT_CONFIG,
    cacheDir: join(cacheDir, label),
    deviceKey: device.key,
    insecureTls: true,
    localApiPort: 0,
    enableNamedPipe: false,
    connection: { heartbeatIntervalMs: 0, autoReconnect: false },
  });
  agents.push(agent);
  await agent.start();
  return agent;
}

beforeEach(async () => {
  cacheDir = mkdtempSync(join(tmpdir(), "cfls-participants-"));
  admin = makeDevice("alice");
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

describe("live participant roster", () => {
  it("reports idle connected peers and moves a disconnected peer to offline", async () => {
    const alice = await startAgent(admin, "alice");
    const bobDevice = makeDevice("bob");
    const bob = await startAgent(bobDevice, "bob");

    await waitUntil(() => {
      const status = alice.agentPort().getConnectionStatus();
      return (
        status.ok &&
        status.data.participants.connected.join(",") === "alice,bob" &&
        status.data.participants.offline.length === 0
      );
    });

    await bob.stop();

    await waitUntil(() => {
      const status = alice.agentPort().getConnectionStatus();
      return (
        status.ok &&
        status.data.participants.connected.join(",") === "alice" &&
        status.data.participants.offline.join(",") === "bob"
      );
    });

    alice.hostConnection().simulateDrop();
    await waitUntil(() => !alice.hostConnection().isOnline());
    const offline = alice.agentPort().getConnectionStatus();
    expect(offline).toMatchObject({
      ok: true,
      data: {
        status: "offline",
        participants: { connected: [], offline: ["alice", "bob"] },
        manualCoordinationRequired: true,
      },
    });
  });
});
