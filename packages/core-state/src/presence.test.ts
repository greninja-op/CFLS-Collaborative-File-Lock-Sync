/**
 * Unit tests for the presence registry (Req 11).
 *
 * Covers: recording started/editing/stopped per member/path; monotonic
 * application that ignores stale (lower-revision) reports; `stopped` ending
 * active presence while retaining the authoritative record; path-equivalence
 * keying (Req 10.3–10.4); per-member independence; and per-session isolation
 * (Req 10.2).
 */

import { describe, expect, it } from "vitest";

import type { MemberRef, SessionId } from "@cfls/protocol";

import { PresenceRegistry } from "./presence";

const session: SessionId = {
  repoId: "github.com/acme/app",
  teamId: "team-1",
  branch: "main",
  baseRevision: "base-1",
};

const otherSession: SessionId = { ...session, teamId: "team-2" };

const alice: MemberRef = { memberId: "alice", deviceId: "alice-dev-1" };
const bob: MemberRef = { memberId: "bob", deviceId: "bob-dev-1" };

describe("PresenceRegistry.report (Req 11.1–11.3)", () => {
  it("records a started presence with its Event_Revision and normalized path", () => {
    const registry = new PresenceRegistry("case-sensitive");
    const presence = registry.report({
      session,
      member: alice,
      path: "./src/./api.ts",
      state: "started",
      eventRevision: 1,
    });

    expect(presence).toEqual({
      member: alice,
      path: "src/api.ts",
      state: "started",
      eventRevision: 1,
    });
    expect(registry.active(session)).toHaveLength(1);
  });

  it("advances started -> editing for the same member/path", () => {
    const registry = new PresenceRegistry("case-sensitive");
    registry.report({ session, member: alice, path: "src/api.ts", state: "started", eventRevision: 1 });
    registry.report({ session, member: alice, path: "src/api.ts", state: "editing", eventRevision: 2 });

    const entry = registry.forMemberPath(session, alice, "src/api.ts");
    expect(entry?.state).toBe("editing");
    expect(entry?.eventRevision).toBe(2);
    expect(registry.active(session)).toHaveLength(1);
  });

  it("ignores a stale (lower-revision) report", () => {
    const registry = new PresenceRegistry("case-sensitive");
    registry.report({ session, member: alice, path: "src/api.ts", state: "editing", eventRevision: 5 });
    // A late 'started' with an older revision must not clobber the newer state.
    const applied = registry.report({
      session,
      member: alice,
      path: "src/api.ts",
      state: "started",
      eventRevision: 3,
    });

    expect(applied.state).toBe("editing");
    expect(applied.eventRevision).toBe(5);
  });
});

describe("PresenceRegistry stopped lifecycle (Req 11.2)", () => {
  it("stopped ends active presence but retains the authoritative record", () => {
    const registry = new PresenceRegistry("case-sensitive");
    registry.report({ session, member: alice, path: "src/api.ts", state: "editing", eventRevision: 1 });
    registry.report({ session, member: alice, path: "src/api.ts", state: "stopped", eventRevision: 2 });

    expect(registry.active(session)).toHaveLength(0);
    const entry = registry.forMemberPath(session, alice, "src/api.ts");
    expect(entry?.state).toBe("stopped");
    expect(entry?.eventRevision).toBe(2);
    expect(registry.all(session)).toHaveLength(1);
  });
});

describe("PresenceRegistry keying and isolation", () => {
  it("treats equivalent path spellings as one entry per member", () => {
    const registry = new PresenceRegistry("case-sensitive");
    registry.report({ session, member: alice, path: "src/api.ts", state: "started", eventRevision: 1 });
    registry.report({ session, member: alice, path: "./src/api.ts", state: "editing", eventRevision: 2 });
    expect(registry.all(session)).toHaveLength(1);
    expect(registry.forMemberPath(session, alice, "src/api.ts")?.state).toBe("editing");
  });

  it("case-folds paths on case-insensitive platforms", () => {
    const registry = new PresenceRegistry("case-insensitive");
    registry.report({ session, member: alice, path: "src/API.ts", state: "started", eventRevision: 1 });
    registry.report({ session, member: alice, path: "src/api.ts", state: "editing", eventRevision: 2 });
    expect(registry.all(session)).toHaveLength(1);
  });

  it("tracks different members on the same path independently", () => {
    const registry = new PresenceRegistry("case-sensitive");
    registry.report({ session, member: alice, path: "src/api.ts", state: "editing", eventRevision: 1 });
    registry.report({ session, member: bob, path: "src/api.ts", state: "started", eventRevision: 2 });

    expect(registry.activeForPath(session, "src/api.ts")).toHaveLength(2);
  });

  it("keeps presence for different sessions independent (Req 10.2)", () => {
    const registry = new PresenceRegistry("case-sensitive");
    registry.report({ session, member: alice, path: "src/api.ts", state: "started", eventRevision: 1 });
    expect(registry.all(otherSession)).toHaveLength(0);
    expect(registry.all(session)).toHaveLength(1);
  });
});
