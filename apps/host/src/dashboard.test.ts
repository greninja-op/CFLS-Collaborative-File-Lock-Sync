/** Unit tests for the metadata-only CoordinationHost dashboard projection. */

import { describe, expect, it } from "vitest";

import type { SessionId, SessionStateSnapshot } from "@cfls/protocol";

import { buildDashboardState, escapeDashboardHtml, renderDashboardHtml } from "./dashboard";

function session(overrides: Partial<SessionId> = {}): SessionId {
  return {
    repoId: "github.com/acme/zeta",
    teamId: "team-zeta",
    branch: "main",
    baseRevision: "base-revision-not-for-dashboard",
    ...overrides,
  };
}

function emptySnapshot(value: SessionId): SessionStateSnapshot {
  return {
    session: value,
    locks: [],
    presence: [],
    intents: [],
    highestRevision: 0,
  };
}

describe("buildDashboardState", () => {
  it("maps only active, safe coordination metadata in a stable order", () => {
    const zeta = session();
    const alphaRelease = session({
      repoId: "github.com/acme/alpha",
      teamId: "team-alpha",
      branch: "release",
    });
    const alphaDevelop = session({
      repoId: "github.com/acme/alpha",
      teamId: "team-alpha",
      branch: "develop",
    });
    const snapshot: SessionStateSnapshot = {
      session: zeta,
      locks: [
        {
          lockId: "lock-private-id",
          scope: "src/z.ts",
          scopeKind: "file",
          mode: "soft",
          holder: { memberId: "zoe", deviceId: "holder-device-not-exposed" },
          branch: "main",
          eventRevision: 3,
          acquiredAt: "2026-07-19T12:00:00.000Z",
          concurrent: false,
        },
        {
          lockId: "lock-script",
          scope: "src/a-<script>alert(1)</script>.ts",
          scopeKind: "file",
          mode: "hard",
          holder: { memberId: "alice", deviceId: "another-private-device" },
          branch: "main",
          eventRevision: 7,
          acquiredAt: "2026-07-19T12:00:01.000Z",
          concurrent: false,
        },
        {
          lockId: "lock-coordination-required",
          scope: "src/coordinate.ts",
          scopeKind: "file",
          mode: "coordination-required",
          holder: { memberId: "cory", deviceId: "coordination-device" },
          branch: "main",
          eventRevision: 8,
          acquiredAt: "2026-07-19T12:00:01.500Z",
          concurrent: false,
        },
        {
          lockId: "concurrent-claim-not-currently-held",
          scope: "src/contended.ts",
          scopeKind: "file",
          mode: "coordination-required",
          holder: { memberId: "bob", deviceId: "concurrent-device" },
          branch: "main",
          eventRevision: 9,
          acquiredAt: "2026-07-19T12:00:02.000Z",
          concurrent: true,
        },
      ],
      presence: [
        {
          member: { memberId: "alice", deviceId: "presence-device" },
          path: "src/a-<script>alert(1)</script>.ts",
          state: "editing",
          eventRevision: 8,
        },
        {
          member: { memberId: "bob", deviceId: "stopped-device" },
          path: "src/stopped.ts",
          state: "stopped",
          eventRevision: 10,
        },
      ],
      intents: [
        {
          intentId: "intent-private-id",
          owner: { memberId: "mira", deviceId: "intent-device-not-exposed" },
          agentId: "agent-private-id",
          modifyPaths: ["src/never-exposed-as-a-plan.ts"],
          createPaths: [{ path: "src/<script>new-file</script>.ts" }],
          scopeKind: "file",
          branch: "main",
          description: "TOP_SECRET_DESCRIPTION_NOT_FOR_DASHBOARD",
          eventRevision: 11,
        },
      ],
      highestRevision: 12,
    };
    const unsafeSnapshot = Object.assign(snapshot, {
      signedInvitation: "SIGNED_INVITATION_NOT_FOR_DASHBOARD",
      token: "TOKEN_NOT_FOR_DASHBOARD",
    });
    const input = {
      uptimeSeconds: 42,
      generatedAt: "2026-07-19T12:34:56.000Z",
      sessions: [
        {
          session: zeta,
          snapshot: unsafeSnapshot,
          connectedDevices: ["device-z", "device-z"],
        },
        {
          session: alphaRelease,
          snapshot: emptySnapshot(alphaRelease),
          connectedDevices: ["device-b"],
        },
        {
          session: alphaDevelop,
          snapshot: emptySnapshot(alphaDevelop),
          connectedDevices: ["device-b", "device-a"],
        },
      ],
    };
    const originalInput = JSON.stringify(input);

    const state = buildDashboardState(input);

    expect(JSON.stringify(input)).toBe(originalInput);
    expect(state.uptimeSeconds).toBe(42);
    expect(state.generatedAt).toBe("2026-07-19T12:34:56.000Z");
    expect(state.totals).toEqual({ sessions: 3, devices: 3, locks: 3 });
    expect(state.sessions.map((entry) => [entry.repoId, entry.branch])).toEqual([
      ["github.com/acme/alpha", "develop"],
      ["github.com/acme/alpha", "release"],
      ["github.com/acme/zeta", "main"],
    ]);

    const displayed = state.sessions[2]!;
    expect(displayed.connectedDevices).toEqual(["device-z"]);
    expect(displayed.locks).toEqual([
      {
        path: "src/a-<script>alert(1)</script>.ts",
        holder: "alice",
        mode: "hard",
        eventRevision: 7,
      },
      {
        path: "src/coordinate.ts",
        holder: "cory",
        mode: "coordination-required",
        eventRevision: 8,
      },
      {
        path: "src/z.ts",
        holder: "zoe",
        mode: "soft",
        eventRevision: 3,
      },
    ]);
    expect(displayed.presence).toEqual([
      { member: "alice", path: "src/a-<script>alert(1)</script>.ts" },
    ]);
    expect(displayed.plannedCreations).toEqual([
      { member: "mira", path: "src/<script>new-file</script>.ts" },
    ]);

    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain("holder-device-not-exposed");
    expect(serialized).not.toContain("lock-private-id");
    expect(serialized).not.toContain("base-revision-not-for-dashboard");
    expect(serialized).not.toContain("agent-private-id");
    expect(serialized).not.toContain("TOP_SECRET_DESCRIPTION_NOT_FOR_DASHBOARD");
    expect(serialized).not.toContain("SIGNED_INVITATION_NOT_FOR_DASHBOARD");
    expect(serialized).not.toContain("TOKEN_NOT_FOR_DASHBOARD");
  });

  it("escapes dynamic paths before the client inserts dashboard state into HTML", () => {
    const path = "src/a-<script>alert(1)</script>.ts";

    expect(escapeDashboardHtml(path)).toBe("src/a-&lt;script&gt;alert(1)&lt;/script&gt;.ts");
  });
});

describe("renderDashboardHtml", () => {
  it("returns a complete standalone, auto-refreshing document", () => {
    const html = renderDashboardHtml();

    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("/api/coordination");
    expect(html).toContain("No active sessions");
    expect(html).toContain("Reconnecting...");
    expect(html).toContain("function escapeHtml");
    expect(html).toContain("The live coordination");
    expect(html).toContain('class="live-demo-card"');
    expect(html).toContain('<circle cx="10.5" cy="18" r="4.4" fill="currentColor"/>');
    expect(html).not.toContain("See the work already in motion");
  });
});
