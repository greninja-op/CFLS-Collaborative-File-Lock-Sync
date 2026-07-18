/**
 * Unit tests for the declared-intent registry (Req 16.1–16.8, 17.1–17.5,
 * 18.1–18.3, 32.1–32.5; design §5.1, §10.2).
 *
 * Covers: recording all mandated fields (Req 16.2); update replacing content
 * with a new revision (Req 16.3); withdraw/complete removal (Req 16.4);
 * create→modify reclassification for existing paths (Req 16.5); format
 * validation for oversize paths, empty sets, and malformed globs (Req 16.7,
 * 32.4); non-owner rejection with the intent retained (`NOT_OWNER`, Req 16.8);
 * reconciliation with real saves and creations (Req 17.1–17.3, 17.5);
 * Planned_File_Creation collision detection and deterministic earliest-revision
 * winner (Req 18.1, 18.3); file/folder/glob scope coverage (Req 32.2, 32.3); and
 * per-session isolation (Req 10.2).
 */

import { describe, expect, it } from "vitest";

import type { MemberRef, SessionId } from "@cfls/protocol";

import { IntentRegistry, type DeclareIntentRequest } from "./intents";

const session: SessionId = {
  repoId: "github.com/acme/app",
  teamId: "team-1",
  branch: "main",
  baseRevision: "base-1",
};

const otherSession: SessionId = { ...session, teamId: "team-2" };

const alice: MemberRef = { memberId: "alice", deviceId: "alice-dev-1" };
const bob: MemberRef = { memberId: "bob", deviceId: "bob-dev-1" };

function decl(overrides: Partial<DeclareIntentRequest> = {}): DeclareIntentRequest {
  return {
    session,
    intentId: "int-1",
    owner: alice,
    agentId: "agent-a",
    modifyPaths: ["src/api.ts"],
    createPaths: [],
    scopeKind: "file",
    branch: "main",
    description: "refactor api",
    eventRevision: 1,
    ...overrides,
  };
}

describe("IntentRegistry.declare — recording (Req 16.1, 16.2)", () => {
  it("records all mandated fields with the assigned Event_Revision", () => {
    const registry = new IntentRegistry("case-sensitive");
    const result = registry.declare(
      decl({
        modifyPaths: ["src/api.ts"],
        createPaths: ["src/new.ts"],
        eventRevision: 7,
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.intent).toMatchObject({
      intentId: "int-1",
      owner: alice,
      agentId: "agent-a",
      modifyPaths: ["src/api.ts"],
      createPaths: [{ path: "src/new.ts" }],
      scopeKind: "file",
      branch: "main",
      description: "refactor api",
      eventRevision: 7,
    });
    expect(registry.allIntents(session)).toHaveLength(1);
  });

  it("normalizes stored paths", () => {
    const registry = new IntentRegistry("case-sensitive");
    const result = registry.declare(
      decl({ modifyPaths: ["./src/./api.ts"], createPaths: ["src/../src/new.ts"] }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.intent.modifyPaths).toEqual(["src/api.ts"]);
    expect(result.intent.createPaths).toEqual([{ path: "src/new.ts" }]);
  });
});

describe("IntentRegistry.declare — reclassification (Req 16.5)", () => {
  it("records a create path that already exists as a modification", () => {
    const registry = new IntentRegistry("case-sensitive");
    registry.setTrackedFiles(session, ["src/existing.ts"]);

    const result = registry.declare(
      decl({ modifyPaths: [], createPaths: ["src/existing.ts", "src/brand-new.ts"] }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reclassified).toEqual([
      { path: "src/existing.ts", as: "modify", reason: "path_exists" },
    ]);
    expect(result.intent.modifyPaths).toContain("src/existing.ts");
    expect(result.intent.createPaths).toEqual([{ path: "src/brand-new.ts" }]);
  });
});

describe("IntentRegistry.declare — validation (Req 16.7, 32.4)", () => {
  it("rejects an intent with neither modify nor create paths", () => {
    const registry = new IntentRegistry("case-sensitive");
    const result = registry.declare(decl({ modifyPaths: [], createPaths: [] }));
    expect(result).toMatchObject({ ok: false, code: "FORMAT_ERROR" });
    expect(registry.allIntents(session)).toHaveLength(0);
  });

  it("rejects a path exceeding 4096 characters and leaves state unchanged", () => {
    const registry = new IntentRegistry("case-sensitive");
    const longPath = `src/${"a".repeat(4100)}.ts`;
    const result = registry.declare(decl({ modifyPaths: [longPath] }));
    expect(result).toMatchObject({ ok: false, code: "FORMAT_ERROR" });
    expect(registry.allIntents(session)).toHaveLength(0);
  });

  it("rejects a malformed glob scope (Req 32.4)", () => {
    const registry = new IntentRegistry("case-sensitive");
    const result = registry.declare(
      decl({ scopeKind: "glob", modifyPaths: ["src/[unclosed/**"] }),
    );
    expect(result).toMatchObject({ ok: false, code: "FORMAT_ERROR" });
    expect(registry.allIntents(session)).toHaveLength(0);
  });
});

describe("IntentRegistry.update (Req 16.3, 16.8)", () => {
  it("replaces content and assigns a new revision for the owner", () => {
    const registry = new IntentRegistry("case-sensitive");
    registry.declare(decl({ eventRevision: 1 }));

    const result = registry.update({
      session,
      intentId: "int-1",
      requester: alice,
      modifyPaths: ["src/other.ts"],
      createPaths: [],
      description: "new plan",
      eventRevision: 5,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.intent.modifyPaths).toEqual(["src/other.ts"]);
    expect(result.intent.description).toBe("new plan");
    expect(result.intent.eventRevision).toBe(5);
  });

  it("rejects an update by a non-owner and retains the intent unchanged (NOT_OWNER)", () => {
    const registry = new IntentRegistry("case-sensitive");
    registry.declare(decl({ eventRevision: 1, description: "original" }));

    const result = registry.update({
      session,
      intentId: "int-1",
      requester: bob,
      modifyPaths: ["hacked.ts"],
      createPaths: [],
      description: "hacked",
      eventRevision: 5,
    });

    expect(result).toEqual({ ok: false, code: "NOT_OWNER" });
    expect(registry.getIntent(session, "int-1")?.description).toBe("original");
    expect(registry.getIntent(session, "int-1")?.modifyPaths).toEqual(["src/api.ts"]);
  });

  it("rejects an update for an unknown intent (NOT_FOUND)", () => {
    const registry = new IntentRegistry("case-sensitive");
    const result = registry.update({
      session,
      intentId: "missing",
      requester: alice,
      modifyPaths: ["x.ts"],
      createPaths: [],
      description: "",
      eventRevision: 2,
    });
    expect(result).toEqual({ ok: false, code: "NOT_FOUND" });
  });
});

describe("IntentRegistry.withdraw / complete (Req 16.4, 16.8)", () => {
  it("removes an owned intent on withdraw", () => {
    const registry = new IntentRegistry("case-sensitive");
    registry.declare(decl());
    const result = registry.withdraw({ session, intentId: "int-1", requester: alice });
    expect(result.ok).toBe(true);
    expect(registry.allIntents(session)).toHaveLength(0);
  });

  it("removes an owned intent on complete", () => {
    const registry = new IntentRegistry("case-sensitive");
    registry.declare(decl());
    const result = registry.complete({ session, intentId: "int-1", requester: alice });
    expect(result.ok).toBe(true);
    expect(registry.allIntents(session)).toHaveLength(0);
  });

  it("rejects withdraw by a non-owner and retains the intent (NOT_OWNER)", () => {
    const registry = new IntentRegistry("case-sensitive");
    registry.declare(decl());
    const result = registry.withdraw({ session, intentId: "int-1", requester: bob });
    expect(result).toEqual({ ok: false, code: "NOT_OWNER" });
    expect(registry.getIntent(session, "int-1")).toBeDefined();
  });

  it("rejects withdraw for an unknown intent (NOT_FOUND)", () => {
    const registry = new IntentRegistry("case-sensitive");
    const result = registry.withdraw({ session, intentId: "nope", requester: alice });
    expect(result).toEqual({ ok: false, code: "NOT_FOUND" });
  });
});

describe("IntentRegistry planned-file-creation collisions (Req 18.1, 18.3)", () => {
  it("records the later declaration as concurrent and reports the winner", () => {
    const registry = new IntentRegistry("case-sensitive");
    registry.declare(
      decl({ intentId: "int-a", owner: alice, modifyPaths: [], createPaths: ["src/shared.ts"], eventRevision: 1 }),
    );
    const result = registry.declare(
      decl({ intentId: "int-b", owner: bob, modifyPaths: [], createPaths: ["src/shared.ts"], eventRevision: 2 }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      path: "src/shared.ts",
      winner: { holder: alice, eventRevision: 1, intentId: "int-a" },
      concurrent: { holder: bob, eventRevision: 2, intentId: "int-b" },
    });
  });

  it("attributes the winner to the earliest revision regardless of declaration order (Req 18.3)", () => {
    const registry = new IntentRegistry("case-sensitive");
    // Declare the higher revision first; the earlier revision must still win.
    registry.declare(
      decl({ intentId: "int-late", owner: bob, modifyPaths: [], createPaths: ["src/shared.ts"], eventRevision: 9 }),
    );
    registry.declare(
      decl({ intentId: "int-early", owner: alice, modifyPaths: [], createPaths: ["src/shared.ts"], eventRevision: 3 }),
    );

    const winner = registry.creationWinner(session, "src/shared.ts", "main");
    expect(winner?.intentId).toBe("int-early");
    expect(winner?.owner).toEqual(alice);

    const claims = registry.creationClaims(session, "src/shared.ts", "main");
    expect(claims.map((c) => c.concurrent)).toEqual([false, true]);
  });

  it("does not treat same-member re-declaration as a conflict", () => {
    const registry = new IntentRegistry("case-sensitive");
    registry.declare(
      decl({ intentId: "int-a", owner: alice, modifyPaths: [], createPaths: ["src/shared.ts"], eventRevision: 1 }),
    );
    const result = registry.declare(
      decl({ intentId: "int-a2", owner: alice, modifyPaths: [], createPaths: ["src/shared.ts"], eventRevision: 2 }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.conflicts).toHaveLength(0);
  });

  it("does not contend across different branches", () => {
    const registry = new IntentRegistry("case-sensitive");
    registry.declare(
      decl({ intentId: "int-a", owner: alice, branch: "main", modifyPaths: [], createPaths: ["src/shared.ts"], eventRevision: 1 }),
    );
    const result = registry.declare(
      decl({ intentId: "int-b", owner: bob, branch: "feature/x", modifyPaths: [], createPaths: ["src/shared.ts"], eventRevision: 2 }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.conflicts).toHaveLength(0);
  });
});

describe("IntentRegistry reconciliation (Req 17.1–17.3, 17.5)", () => {
  it("removes a Planned_File_Creation when the file is actually created (Req 17.2)", () => {
    const registry = new IntentRegistry("case-sensitive");
    registry.declare(
      decl({ modifyPaths: [], createPaths: ["src/new.ts"], eventRevision: 1 }),
    );

    const recon = registry.reconcileCreation(session, "src/new.ts");
    expect(recon.trackedAdded).toBe(true);
    expect(recon.removedFrom.map((i) => i.intentId)).toEqual(["int-1"]);
    expect(registry.getIntent(session, "int-1")?.createPaths).toEqual([]);
    expect(registry.isTracked(session, "src/new.ts")).toBe(true);
  });

  it("records an unplanned creation as a tracked file (Req 17.3)", () => {
    const registry = new IntentRegistry("case-sensitive");
    const recon = registry.reconcileCreation(session, "src/surprise.ts");
    expect(recon.trackedAdded).toBe(true);
    expect(recon.removedFrom).toHaveLength(0);
    expect(registry.isTracked(session, "src/surprise.ts")).toBe(true);
  });

  it("marks a planned modification as in-progress on a real save (Req 17.1)", () => {
    const registry = new IntentRegistry("case-sensitive");
    registry.declare(decl({ modifyPaths: ["src/api.ts"], eventRevision: 1 }));
    const recon = registry.reconcileSave(session, "src/api.ts");
    expect(recon.inProgress.map((i) => i.intentId)).toEqual(["int-1"]);
    expect(registry.inProgressPaths(session, "int-1")).toEqual(["src/api.ts"]);
  });

  it("withdraws a not-yet-created Planned_File_Creation (Req 17.5)", () => {
    const registry = new IntentRegistry("case-sensitive");
    registry.declare(
      decl({ modifyPaths: [], createPaths: ["src/new.ts", "src/keep.ts"], eventRevision: 1 }),
    );
    const result = registry.withdrawPlannedCreation(session, "int-1", "src/new.ts", alice);
    expect(result.ok).toBe(true);
    expect(registry.getIntent(session, "int-1")?.createPaths).toEqual([{ path: "src/keep.ts" }]);
  });

  it("rejects withdrawing a Planned_File_Creation from an intent the requester does not own", () => {
    const registry = new IntentRegistry("case-sensitive");
    registry.declare(decl({ modifyPaths: [], createPaths: ["src/new.ts"], eventRevision: 1 }));
    const result = registry.withdrawPlannedCreation(session, "int-1", "src/new.ts", bob);
    expect(result).toEqual({ ok: false, code: "NOT_OWNER" });
  });
});

describe("IntentRegistry scoped coverage (Req 32.2, 32.3, 32.5)", () => {
  it("covers a path inside a declared folder scope", () => {
    const registry = new IntentRegistry("case-sensitive");
    registry.declare(
      decl({ scopeKind: "folder", modifyPaths: ["src/api"], eventRevision: 1 }),
    );
    const covering = registry.intentsCovering(session, "src/api/handlers/users.ts", "main");
    expect(covering.map((c) => c.intent.intentId)).toEqual(["int-1"]);
    expect(covering[0]?.matchedScope).toBe("src/api");
  });

  it("covers a path matching a declared glob scope", () => {
    const registry = new IntentRegistry("case-sensitive");
    registry.declare(
      decl({ scopeKind: "glob", modifyPaths: ["src/**/*.test.ts"], eventRevision: 1 }),
    );
    const covering = registry.intentsCovering(session, "src/api/users.test.ts", "main");
    expect(covering).toHaveLength(1);
  });

  it("does not cover a path outside a folder scope", () => {
    const registry = new IntentRegistry("case-sensitive");
    registry.declare(decl({ scopeKind: "folder", modifyPaths: ["src/api"], eventRevision: 1 }));
    expect(registry.intentsCovering(session, "src/db/pool.ts", "main")).toHaveLength(0);
  });

  it("covers only exact paths for a file scope", () => {
    const registry = new IntentRegistry("case-sensitive");
    registry.declare(decl({ scopeKind: "file", modifyPaths: ["src/api.ts"], eventRevision: 1 }));
    expect(registry.intentsCovering(session, "src/api.ts", "main")).toHaveLength(1);
    expect(registry.intentsCovering(session, "src/api.ts.bak", "main")).toHaveLength(0);
  });
});

describe("IntentRegistry session isolation (Req 10.2)", () => {
  it("keeps intents for different sessions independent", () => {
    const registry = new IntentRegistry("case-sensitive");
    registry.declare(decl({ session }));
    expect(registry.allIntents(otherSession)).toHaveLength(0);
    expect(registry.allIntents(session)).toHaveLength(1);
  });
});
