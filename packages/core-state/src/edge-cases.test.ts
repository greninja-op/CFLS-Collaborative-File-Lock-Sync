/**
 * Focused edge-case & error-code unit tests for the lock/intent/presence logic
 * (task 4.26).
 *
 * Consolidates the coordination corner cases and typed error codes called out
 * by the task:
 *   - release-by-non-holder → `NOT_LOCK_HOLDER` (Req 12.7)
 *   - release-with-no-lock → `NO_ACTIVE_LOCK` (Req 12.8)
 *   - cross-branch non-conflict for locks, intents, and the Risk_Map (Req 12.4,
 *     18, 21.3)
 *   - coordination-required override missing reason → `OVERRIDE_REASON_REQUIRED`
 *     (Req 13.3, 13.4)
 *   - rename/move/delete path tracking for locks and intents (Req 30.2, 30.3,
 *     30.5, 30.7)
 */

import { describe, expect, it } from "vitest";

import type { MemberRef, SessionId } from "@cfls/protocol";

import { IntentRegistry, type DeclareIntentRequest } from "./intents";
import { LockRegistry, type LockAcquisition } from "./locks";
import { validateOverride, type OverrideRequest } from "./override";
import { PresenceRegistry } from "./presence";
import { buildRiskMap } from "./risk";
import { ALL_SOFT_CONFIG } from "./rules";

const session: SessionId = {
  repoId: "github.com/acme/app",
  teamId: "team-1",
  branch: "main",
  baseRevision: "base-1",
};

const alice: MemberRef = { memberId: "alice", deviceId: "alice-dev-1" };
const bob: MemberRef = { memberId: "bob", deviceId: "bob-dev-1" };

function acq(overrides: Partial<LockAcquisition> = {}): LockAcquisition {
  return {
    session,
    lockId: "lock-1",
    scope: "src/api.ts",
    scopeKind: "file",
    mode: "soft",
    holder: alice,
    branch: "main",
    eventRevision: 1,
    acquiredAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function decl(
  overrides: Partial<DeclareIntentRequest> = {},
): DeclareIntentRequest {
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

// ---------------------------------------------------------------------------
// Lock release error codes (Req 12.7, 12.8)
// ---------------------------------------------------------------------------

describe("lock release error codes (Req 12.7, 12.8)", () => {
  it("rejects a release by a non-holder with NOT_LOCK_HOLDER and retains the lock (Req 12.7)", () => {
    const registry = new LockRegistry("case-sensitive");
    registry.acquire(acq({ holder: alice, eventRevision: 1 }));

    const result = registry.release({
      session,
      requester: bob,
      branch: "main",
      lockId: "lock-1",
    });

    expect(result).toEqual({ ok: false, code: "NOT_LOCK_HOLDER" });
    // The lock is retained unchanged for its original holder.
    expect(
      registry.winningLock(session, "src/api.ts", "file", "main")?.holder,
    ).toEqual(alice);
  });

  it("rejects a non-holder release identified by scope with NOT_LOCK_HOLDER (Req 12.7)", () => {
    const registry = new LockRegistry("case-sensitive");
    registry.acquire(acq({ holder: alice, eventRevision: 1 }));

    const result = registry.release({
      session,
      requester: bob,
      branch: "main",
      scope: "src/api.ts",
    });

    expect(result).toEqual({ ok: false, code: "NOT_LOCK_HOLDER" });
    expect(registry.allLocks(session)).toHaveLength(1);
  });

  it("rejects a release for a path with no active lock with NO_ACTIVE_LOCK (Req 12.8)", () => {
    const registry = new LockRegistry("case-sensitive");
    const result = registry.release({
      session,
      requester: alice,
      branch: "main",
      scope: "src/never-locked.ts",
    });
    expect(result).toEqual({ ok: false, code: "NO_ACTIVE_LOCK" });
  });

  it("rejects a release by an unknown lockId with NO_ACTIVE_LOCK (Req 12.8)", () => {
    const registry = new LockRegistry("case-sensitive");
    registry.acquire(acq({ eventRevision: 1 }));
    const result = registry.release({
      session,
      requester: alice,
      branch: "main",
      lockId: "ghost-lock",
    });
    expect(result).toEqual({ ok: false, code: "NO_ACTIVE_LOCK" });
  });

  it("rejects a release on the wrong branch with NO_ACTIVE_LOCK (Req 12.8)", () => {
    const registry = new LockRegistry("case-sensitive");
    registry.acquire(acq({ holder: alice, branch: "main", eventRevision: 1 }));
    const result = registry.release({
      session,
      requester: alice,
      branch: "feature/x",
      scope: "src/api.ts",
    });
    expect(result).toEqual({ ok: false, code: "NO_ACTIVE_LOCK" });
  });
});

// ---------------------------------------------------------------------------
// Cross-branch non-conflict (Req 12.4, 18, 21.3)
// ---------------------------------------------------------------------------

describe("cross-branch non-conflict (Req 12.4, 18, 21.3)", () => {
  it("does not contend two locks on the same path under different branches (Req 12.4)", () => {
    const registry = new LockRegistry("case-sensitive");
    registry.acquire(acq({ holder: alice, branch: "main", eventRevision: 1 }));
    const outcome = registry.acquire(
      acq({
        lockId: "lock-2",
        holder: bob,
        branch: "feature/x",
        eventRevision: 2,
      }),
    );

    expect(outcome.contended).toBe(false);
    expect(outcome.lock.concurrent).toBe(false);
    // Each branch keeps its own independent winning lock.
    expect(
      registry.winningLock(session, "src/api.ts", "file", "main")?.holder,
    ).toEqual(alice);
    expect(
      registry.winningLock(session, "src/api.ts", "file", "feature/x")?.holder,
    ).toEqual(bob);
  });

  it("does not collide two planned creations of the same path on different branches (Req 18)", () => {
    const registry = new IntentRegistry("case-sensitive");
    registry.declare(
      decl({
        intentId: "int-a",
        owner: alice,
        branch: "main",
        modifyPaths: [],
        createPaths: ["src/shared.ts"],
        eventRevision: 1,
      }),
    );
    const result = registry.declare(
      decl({
        intentId: "int-b",
        owner: bob,
        branch: "feature/x",
        modifyPaths: [],
        createPaths: ["src/shared.ts"],
        eventRevision: 2,
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.conflicts).toHaveLength(0);
  });

  it("classifies same-path other-branch lock activity as reduced/no direct conflict and surfaces the distinct branch (Req 21.3)", () => {
    const registry = new LockRegistry("case-sensitive");
    // Bob holds a lock on the SAME path but under a DIFFERENT branch.
    registry.acquire(
      acq({
        holder: bob,
        branch: "feature/x",
        scope: "src/api.ts",
        eventRevision: 1,
      }),
    );

    // Alice queries the Risk_Map on `main`.
    const entries = buildRiskMap({
      requester: alice,
      branch: "main",
      locks: registry.allLocks(session),
      presence: [],
      intents: [],
      rules: ALL_SOFT_CONFIG,
      sensitivity: "case-sensitive",
    });

    const entry = entries.find((e) => e.path === "src/api.ts");
    expect(entry).toBeDefined();
    // Not a direct conflict — it is soft with the distinct branch surfaced.
    expect(entry?.riskLevel).toBe("soft");
    expect(entry?.explanation.type).toBe("direct");
    expect(entry?.contributors).toHaveLength(1);
    expect(entry?.contributors[0]?.member).toEqual(bob);
    expect(entry?.contributors[0]?.kind).toContain("branch: feature/x");
  });

  it("treats same-path same-branch other-member lock activity as a direct conflict (Req 21.1 contrast)", () => {
    const registry = new LockRegistry("case-sensitive");
    registry.acquire(
      acq({
        holder: bob,
        branch: "main",
        scope: "src/api.ts",
        eventRevision: 1,
      }),
    );

    const entries = buildRiskMap({
      requester: alice,
      branch: "main",
      locks: registry.allLocks(session),
      presence: [],
      intents: [],
      rules: ALL_SOFT_CONFIG,
      sensitivity: "case-sensitive",
    });

    const entry = entries.find((e) => e.path === "src/api.ts");
    expect(entry?.explanation.type).toBe("direct");
    expect(entry?.contributors[0]?.kind).not.toContain("branch:");
  });
});

// ---------------------------------------------------------------------------
// Coordination-required override reason (Req 13.3, 13.4)
// ---------------------------------------------------------------------------

describe("coordination-required override reason (Req 13.3, 13.4)", () => {
  function req(overrides: Partial<OverrideRequest> = {}): OverrideRequest {
    return {
      session,
      member: alice,
      scope: "src/critical.ts",
      overrideReason: "hotfix approved by lead",
      eventRevision: 10,
      at: "2024-01-01T00:00:00.000Z",
      ...overrides,
    };
  }

  it("rejects an override with a missing (empty) reason with OVERRIDE_REASON_REQUIRED (Req 13.4)", () => {
    const result = validateOverride(req({ overrideReason: "" }));
    expect(result).toEqual({ ok: false, code: "OVERRIDE_REASON_REQUIRED" });
  });

  it("rejects an override with a whitespace-only reason with OVERRIDE_REASON_REQUIRED (Req 13.4)", () => {
    const result = validateOverride(req({ overrideReason: "   \t\n" }));
    expect(result).toEqual({ ok: false, code: "OVERRIDE_REASON_REQUIRED" });
  });

  it("accepts an override with a reason and records an Audit_Record with no source content (Req 13.3)", () => {
    const result = validateOverride(req({ overrideReason: "hotfix approved" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.audit).toEqual({
      member: alice,
      action: "override",
      targetScope: "src/critical.ts",
      eventRevision: 10,
      time: "2024-01-01T00:00:00.000Z",
      overrideReason: "hotfix approved",
    });
  });
});

// ---------------------------------------------------------------------------
// Rename / move / delete path tracking (Req 30.2, 30.3, 30.5, 30.7)
// ---------------------------------------------------------------------------

describe("lock rename/move/delete tracking (Req 30.2, 30.5, 30.7)", () => {
  it("transfers a member's lock to the new path on rename, retaining the holder and stamping a new revision (Req 30.2)", () => {
    const registry = new LockRegistry("case-sensitive");
    registry.acquire(
      acq({ holder: alice, scope: "src/old.ts", eventRevision: 1 }),
    );

    const moved = registry.transferPath({
      session,
      member: alice,
      fromScope: "src/old.ts",
      toScope: "src/new.ts",
      scopeKind: "file",
      branch: "main",
      eventRevision: 7,
    });

    expect(moved).toBeDefined();
    expect(moved?.scope).toBe("src/new.ts");
    expect(moved?.holder).toEqual(alice);
    expect(moved?.eventRevision).toBe(7);
    // Old path no longer holds a lock; new path does.
    expect(
      registry.winningLock(session, "src/old.ts", "file", "main"),
    ).toBeUndefined();
    expect(
      registry.winningLock(session, "src/new.ts", "file", "main")?.holder,
    ).toEqual(alice);
  });

  it("leaves other members' claims intact on the source path after a transfer (Req 30.2)", () => {
    const registry = new LockRegistry("case-sensitive");
    registry.acquire(
      acq({
        holder: alice,
        lockId: "lock-a",
        scope: "src/old.ts",
        eventRevision: 1,
      }),
    );
    registry.acquire(
      acq({
        holder: bob,
        lockId: "lock-b",
        scope: "src/old.ts",
        eventRevision: 2,
      }),
    );

    registry.transferPath({
      session,
      member: alice,
      fromScope: "src/old.ts",
      toScope: "src/new.ts",
      scopeKind: "file",
      branch: "main",
      eventRevision: 9,
    });

    // Bob's claim is promoted to winner on the old path.
    expect(
      registry.winningLock(session, "src/old.ts", "file", "main")?.holder,
    ).toEqual(bob);
  });

  it("returns undefined for a rename of a path the member does not lock (Req 30.7)", () => {
    const registry = new LockRegistry("case-sensitive");
    const moved = registry.transferPath({
      session,
      member: alice,
      fromScope: "src/untracked.ts",
      toScope: "src/moved.ts",
      scopeKind: "file",
      branch: "main",
      eventRevision: 3,
    });
    expect(moved).toBeUndefined();
    expect(registry.allLocks(session)).toHaveLength(0);
  });

  it("releases the deleting member's lock on deletion, leaving others intact (Req 30.5)", () => {
    const registry = new LockRegistry("case-sensitive");
    registry.acquire(
      acq({
        holder: alice,
        lockId: "lock-a",
        scope: "src/gone.ts",
        eventRevision: 1,
      }),
    );
    registry.acquire(
      acq({
        holder: bob,
        lockId: "lock-b",
        scope: "src/gone.ts",
        eventRevision: 2,
      }),
    );

    const removed = registry.releaseOnDelete(
      session,
      "src/gone.ts",
      "file",
      "main",
      alice,
    );
    expect(removed?.holder).toEqual(alice);
    // Bob's claim survives and is promoted.
    expect(
      registry.winningLock(session, "src/gone.ts", "file", "main")?.holder,
    ).toEqual(bob);
  });

  it("returns undefined for a deletion of a path the member does not lock (Req 30.7)", () => {
    const registry = new LockRegistry("case-sensitive");
    registry.acquire(
      acq({ holder: bob, scope: "src/gone.ts", eventRevision: 1 }),
    );
    const removed = registry.releaseOnDelete(
      session,
      "src/gone.ts",
      "file",
      "main",
      alice,
    );
    expect(removed).toBeUndefined();
    // Bob's lock is untouched.
    expect(
      registry.winningLock(session, "src/gone.ts", "file", "main")?.holder,
    ).toEqual(bob);
  });
});

describe("intent rename/move/delete tracking (Req 30.3, 30.5, 30.7)", () => {
  it("rewrites planned modifications and creations from the old path to the new path on rename (Req 30.3)", () => {
    const registry = new IntentRegistry("case-sensitive");
    registry.declare(
      decl({
        intentId: "int-a",
        modifyPaths: ["src/old.ts", "src/keep.ts"],
        createPaths: [],
        eventRevision: 1,
      }),
    );
    registry.declare(
      decl({
        intentId: "int-b",
        owner: bob,
        modifyPaths: [],
        createPaths: ["src/old.ts"],
        eventRevision: 2,
      }),
    );

    const updated = registry.renamePath(session, "src/old.ts", "src/new.ts");
    expect(updated.map((i) => i.intentId).sort()).toEqual(["int-a", "int-b"]);

    expect(registry.getIntent(session, "int-a")?.modifyPaths).toEqual([
      "src/new.ts",
      "src/keep.ts",
    ]);
    expect(registry.getIntent(session, "int-b")?.createPaths).toEqual([
      { path: "src/new.ts" },
    ]);
  });

  it("follows a renamed path in the tracked-file set (Req 30.3)", () => {
    const registry = new IntentRegistry("case-sensitive");
    registry.markTracked(session, "src/old.ts");
    registry.renamePath(session, "src/old.ts", "src/new.ts");
    expect(registry.isTracked(session, "src/old.ts")).toBe(false);
    expect(registry.isTracked(session, "src/new.ts")).toBe(true);
  });

  it("returns no updated intents when a renamed path is not referenced (Req 30.7)", () => {
    const registry = new IntentRegistry("case-sensitive");
    registry.declare(decl({ modifyPaths: ["src/other.ts"], eventRevision: 1 }));
    const updated = registry.renamePath(
      session,
      "src/absent.ts",
      "src/moved.ts",
    );
    expect(updated).toHaveLength(0);
    expect(registry.getIntent(session, "int-1")?.modifyPaths).toEqual([
      "src/other.ts",
    ]);
  });

  it("removes the deleting member's references but leaves other members' intents intact (Req 30.5)", () => {
    const registry = new IntentRegistry("case-sensitive");
    registry.declare(
      decl({
        intentId: "int-a",
        owner: alice,
        modifyPaths: ["src/gone.ts", "src/keep.ts"],
        eventRevision: 1,
      }),
    );
    registry.declare(
      decl({
        intentId: "int-b",
        owner: bob,
        modifyPaths: ["src/gone.ts"],
        eventRevision: 2,
      }),
    );

    const updated = registry.deletePathForMember(session, "src/gone.ts", alice);
    expect(updated.map((i) => i.intentId)).toEqual(["int-a"]);
    expect(registry.getIntent(session, "int-a")?.modifyPaths).toEqual([
      "src/keep.ts",
    ]);
    // Bob's intent still references the deleted path (not the deleting member).
    expect(registry.getIntent(session, "int-b")?.modifyPaths).toEqual([
      "src/gone.ts",
    ]);
  });

  it("drops a deleted path from the tracked-file set (Req 30.7)", () => {
    const registry = new IntentRegistry("case-sensitive");
    registry.markTracked(session, "src/gone.ts");
    registry.deletePathForMember(session, "src/gone.ts", alice);
    expect(registry.isTracked(session, "src/gone.ts")).toBe(false);
  });

  it("returns no updated intents when the deleting member references no such path (Req 30.7)", () => {
    const registry = new IntentRegistry("case-sensitive");
    registry.declare(
      decl({ owner: alice, modifyPaths: ["src/keep.ts"], eventRevision: 1 }),
    );
    const updated = registry.deletePathForMember(session, "src/gone.ts", alice);
    expect(updated).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Presence stopped-state edge case (Req 11) — sanity for the projection inputs
// ---------------------------------------------------------------------------

describe("presence edge cases (Req 11)", () => {
  it("excludes a stopped member from active presence", () => {
    const registry = new PresenceRegistry("case-sensitive");
    registry.report({
      session,
      member: bob,
      path: "src/api.ts",
      state: "editing",
      eventRevision: 1,
    });
    registry.report({
      session,
      member: bob,
      path: "src/api.ts",
      state: "stopped",
      eventRevision: 2,
    });
    expect(registry.active(session)).toHaveLength(0);
  });

  it("ignores a stale (lower-revision) presence report (Req 11.3)", () => {
    const registry = new PresenceRegistry("case-sensitive");
    registry.report({
      session,
      member: bob,
      path: "src/api.ts",
      state: "editing",
      eventRevision: 5,
    });
    const applied = registry.report({
      session,
      member: bob,
      path: "src/api.ts",
      state: "stopped",
      eventRevision: 2,
    });
    // The stale stopped event is ignored; the member remains editing.
    expect(applied.state).toBe("editing");
    expect(registry.active(session)).toHaveLength(1);
  });
});
