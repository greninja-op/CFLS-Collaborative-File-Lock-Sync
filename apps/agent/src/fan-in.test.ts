/**
 * Unit tests for multi-client fan-in under one device identity and own-view
 * consolidation (task 9.9; Req 31.1–31.5). Multiple local clients driving the
 * same {@link AgentCoordinationPort} share one consistent view; a member's own
 * activity is excluded from its own Risk_Map while a peer sees it consolidated
 * under the single member identity.
 */

import { ALL_SOFT_CONFIG } from "@cfls/core-state";
import type { CoordinationUpdate, MemberRef, SessionId } from "@cfls/protocol";
import { describe, expect, it } from "vitest";

import { LocalHostGateway } from "./gateway";
import { AgentCoordinationPort } from "./port";
import { AgentView } from "./view";

const session: SessionId = {
  repoId: "github.com/acme/app",
  teamId: "team-1",
  branch: "main",
  baseRevision: null,
};

const alice: MemberRef = { memberId: "alice", deviceId: "dev-a1" };

function makePort(): {
  port: AgentCoordinationPort;
  gateway: LocalHostGateway;
} {
  const gateway = new LocalHostGateway({
    session,
    self: alice,
    rules: ALL_SOFT_CONFIG,
  });
  const port = new AgentCoordinationPort({
    session,
    self: alice,
    gateway,
    rules: ALL_SOFT_CONFIG,
    view: new AgentView(),
  });
  return { port, gateway };
}

describe("multi-client fan-in (Req 31.1)", () => {
  it("consolidates activity from multiple local clients into one shared view", async () => {
    const { port } = makePort();

    // Two different local clients (e.g. the MCP server and the extension), both
    // acting under alice's single device identity, mutate through the one port.
    const first = await port.declareIntent({
      session,
      modifyPaths: ["src/a.ts"],
      createPaths: [],
      description: "client-1",
    });
    const second = await port.acquireLock({
      session,
      scope: "src/b.ts",
      scopeKind: "file",
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    // The shared view holds both, attributed to the one member identity.
    const entries = port.view.entries(session);
    const owners = new Set(entries.map((e) => e.member.memberId));
    expect(owners).toEqual(new Set(["alice"]));
    expect(entries.map((e) => e.path).sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("excludes the member's own activity from its own Risk_Map (Req 31.5)", async () => {
    const { port } = makePort();
    await port.declareIntent({
      session,
      modifyPaths: ["src/a.ts"],
      createPaths: [],
      description: "own",
    });
    await port.acquireLock({ session, scope: "src/b.ts", scopeKind: "file" });

    const risk = port.getRiskMap({ session });
    expect(risk.ok).toBe(true);
    if (risk.ok) {
      // Own locks/intents never appear as risks against the member itself.
      expect(risk.data.paths).toHaveLength(0);
    }
  });

  it("surfaces a peer's activity consolidated under the peer's single identity", async () => {
    const { port, gateway } = makePort();

    // Alice's own client acquires a lock (excluded from alice's own map).
    await port.acquireLock({ session, scope: "src/own.ts", scopeKind: "file" });

    // A peer (bob) touches two paths from two of HIS devices; the host broadcasts
    // arrive at alice's agent and must consolidate under the single memberId.
    const bobDev1: MemberRef = { memberId: "bob", deviceId: "dev-b1" };
    const bobDev2: MemberRef = { memberId: "bob", deviceId: "dev-b2" };
    const updates: CoordinationUpdate[] = [
      {
        entryType: "soft_lock",
        op: "added",
        path: "src/peer1.ts",
        member: bobDev1,
        eventRevision: 50,
      },
      {
        entryType: "intent",
        op: "added",
        path: "src/peer2.ts",
        member: bobDev2,
        eventRevision: 51,
      },
    ];
    for (const u of updates) {
      gateway.injectRemote(u);
    }

    const risk = port.getRiskMap({ session });
    expect(risk.ok).toBe(true);
    if (risk.ok) {
      const paths = risk.data.paths.map((p) => p.path).sort();
      expect(paths).toEqual(["src/peer1.ts", "src/peer2.ts"]);
      // Every contributor collapses to bob's single member identity (Req 31.2/31.5).
      const contributors = new Set(
        risk.data.paths.flatMap((p) => p.contributors.map((c) => c.memberId)),
      );
      expect(contributors).toEqual(new Set(["bob"]));
      // Alice's own path is never present in her own map.
      expect(paths).not.toContain("src/own.ts");
    }
  });

  it("returns OFFLINE_QUEUED for mutations while offline, without mutating the view", async () => {
    const { port, gateway } = makePort();
    gateway.setOnline(false);
    const result = await port.acquireLock({
      session,
      scope: "src/x.ts",
      scopeKind: "file",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("OFFLINE_QUEUED");
    }
    expect(port.view.entries(session)).toHaveLength(0);
  });
});
