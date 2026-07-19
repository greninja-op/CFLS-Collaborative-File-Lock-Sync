/**
 * Unit tests for offline behaviour and the connectivity/staleness snapshots
 * surfaced by the core-state-backed agent port (task 7.4; Req 4.8, 33.1, 33.2).
 */

import type { MemberRef, SessionId } from "@cfls/protocol";
import { describe, expect, it } from "vitest";

import { CoreStateAgentPort } from "./fake-agent";

const session: SessionId = {
  repoId: "repo-1",
  teamId: "team-1",
  branch: "main",
  baseRevision: null,
};
const self: MemberRef = { memberId: "u-1", deviceId: "d-1" };

function makeAgent(online: boolean): CoreStateAgentPort {
  let clock = Date.parse("2024-01-01T00:00:00.000Z");
  const agent = new CoreStateAgentPort({
    session,
    self,
    online,
    now: () => clock,
    lastSyncAt: "2024-01-01T00:00:00.000Z",
  });
  // Advance the injected clock 45s past the last sync.
  clock += 45_000;
  return agent;
}

describe("connectivity + staleness snapshots", () => {
  it("reports online/fresh when connected (Req 33.2)", () => {
    const agent = makeAgent(true);
    expect(agent.getConnection().status).toBe("online");
    expect(agent.getConnection().hostUrl).toContain("wss://");
    expect(agent.getStaleness().stale).toBe(false);
    expect(agent.getStaleness().secondsSinceSync).toBe(45);
  });

  it("reports offline/stale when disconnected (Req 33.2, 33.3)", () => {
    const agent = makeAgent(false);
    expect(agent.getConnection().status).toBe("offline");
    expect(agent.getStaleness().stale).toBe(true);
    // Staleness still reports the elapsed seconds since the last sync.
    expect(agent.getStaleness().secondsSinceSync).toBe(45);
  });
});

describe("offline mutation behaviour (Req 4.8)", () => {
  it("declare_intent returns OFFLINE_QUEUED while offline", async () => {
    const agent = makeAgent(false);
    const result = await agent.declareIntent({
      session,
      modifyPaths: ["src/a.ts"],
      createPaths: [],
      description: "x",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected offline failure");
    expect(result.error.code).toBe("OFFLINE_QUEUED");
  });

  it("acquire_lock returns OFFLINE_QUEUED while offline and mutates no state", async () => {
    const agent = makeAgent(false);
    const offline = await agent.acquireLock({
      session,
      scope: "src/a.ts",
      scopeKind: "file",
    });
    expect(offline.ok).toBe(false);
    if (offline.ok) throw new Error("expected offline failure");
    expect(offline.error.code).toBe("OFFLINE_QUEUED");

    // Reconnect: the offline attempt consumed no Event_Revision, so the first
    // accepted lock is revision 1.
    agent.setOnline(true);
    const online = await agent.acquireLock({
      session,
      scope: "src/a.ts",
      scopeKind: "file",
    });
    expect(online.ok).toBe(true);
    if (!online.ok) throw new Error("expected success");
    expect(online.data.granted).toBe(true);
    expect(online.data.eventRevision).toBe(1);
  });

  it("release_lock and update/withdraw are OFFLINE_QUEUED while offline", async () => {
    const agent = makeAgent(false);
    for (const result of await Promise.all([
      agent.releaseLock({ scope: "src/a.ts" }),
      agent.updateIntent({
        intentId: "int-1",
        modifyPaths: ["src/a.ts"],
        createPaths: [],
        description: "x",
      }),
      agent.withdrawIntent({ intentId: "int-1" }),
    ])) {
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected offline failure");
      expect(result.error.code).toBe("OFFLINE_QUEUED");
    }
  });

  it("queries still succeed while offline, serving stale data (Req 33.1)", async () => {
    const agent = makeAgent(false);
    const status = await agent.getProjectSessionStatus();
    expect(status.ok).toBe(true);
    const risk = await agent.getRiskMap({ session });
    expect(risk.ok).toBe(true);
  });
});
