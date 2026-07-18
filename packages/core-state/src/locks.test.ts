/**
 * Unit tests for the lock registry (Req 12.1–12.8, 13, 14; design §10.3, §10.4).
 *
 * Covers: recording all mandated fields (Req 12.3) for soft/coordination-
 * required/hard modes; uncontended acquisition; concurrent-claim recording with
 * the returned existing holder (Req 12.4); cross-branch and cross-scope
 * non-contention; holder-checked release (Req 12.6); non-holder rejection with
 * the lock retained (`NOT_LOCK_HOLDER`, Req 12.7); no-active-lock rejection
 * (`NO_ACTIVE_LOCK`, Req 12.8); winner promotion; path-equivalence keying; and
 * per-session isolation.
 */

import { describe, expect, it } from "vitest";

import type { MemberRef, SessionId } from "@cfls/protocol";

import { LockRegistry, type LockAcquisition } from "./locks";

const session: SessionId = {
  repoId: "github.com/acme/app",
  teamId: "team-1",
  branch: "main",
  baseRevision: "base-1",
};

const otherSession: SessionId = { ...session, teamId: "team-2" };

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

describe("LockRegistry.acquire — uncontended (Req 12.1–12.3)", () => {
  it("records a soft lock with all mandated fields and no contention", () => {
    const registry = new LockRegistry("case-sensitive");
    const outcome = registry.acquire(acq());

    expect(outcome.contended).toBe(false);
    expect(outcome.lock).toEqual(outcome.winner);
    expect(outcome.lock).toMatchObject({
      lockId: "lock-1",
      scope: "src/api.ts",
      scopeKind: "file",
      mode: "soft",
      holder: alice, // holder identity + originating device
      branch: "main",
      eventRevision: 1,
      acquiredAt: "2024-01-01T00:00:00.000Z",
      concurrent: false,
    });
  });

  it.each(["soft", "coordination-required", "hard"] as const)(
    "records a %s lock identically",
    (mode) => {
      const registry = new LockRegistry("case-sensitive");
      const outcome = registry.acquire(acq({ mode }));
      expect(outcome.lock.mode).toBe(mode);
      expect(outcome.contended).toBe(false);
    },
  );

  it("re-acquisition by the current holder is idempotent (no new claim)", () => {
    const registry = new LockRegistry("case-sensitive");
    registry.acquire(acq({ eventRevision: 1 }));
    const outcome = registry.acquire(acq({ lockId: "lock-1b", eventRevision: 2 }));

    expect(outcome.contended).toBe(false);
    expect(outcome.lock.lockId).toBe("lock-1"); // original winner returned
    expect(registry.allLocks(session)).toHaveLength(1);
  });
});

describe("LockRegistry.acquire — contention (Req 12.4)", () => {
  it("records a second member's claim as concurrent and returns the existing holder", () => {
    const registry = new LockRegistry("case-sensitive");
    registry.acquire(acq({ holder: alice, eventRevision: 1 }));

    const outcome = registry.acquire(
      acq({ lockId: "lock-2", holder: bob, eventRevision: 2 }),
    );

    expect(outcome.contended).toBe(true);
    expect(outcome.lock.concurrent).toBe(true);
    expect(outcome.winner.holder).toEqual(alice);
    expect(outcome.winner.eventRevision).toBe(1);
    // Alice remains the single winning lock.
    expect(registry.winningLock(session, "src/api.ts", "file", "main")?.holder).toEqual(
      alice,
    );
  });

  it("does not contend across different branches (Req 12.4 same-branch clause)", () => {
    const registry = new LockRegistry("case-sensitive");
    registry.acquire(acq({ holder: alice, branch: "main", eventRevision: 1 }));
    const outcome = registry.acquire(
      acq({ lockId: "lock-2", holder: bob, branch: "feature/x", eventRevision: 2 }),
    );
    expect(outcome.contended).toBe(false);
    expect(outcome.lock.concurrent).toBe(false);
  });

  it("does not contend across different scopes", () => {
    const registry = new LockRegistry("case-sensitive");
    registry.acquire(acq({ scope: "src/api.ts", eventRevision: 1 }));
    const outcome = registry.acquire(
      acq({ lockId: "lock-2", holder: bob, scope: "src/db.ts", eventRevision: 2 }),
    );
    expect(outcome.contended).toBe(false);
  });
});

describe("LockRegistry path-equivalence keying (Req 10.3–10.4)", () => {
  it("treats equivalent path spellings as the same scope", () => {
    const registry = new LockRegistry("case-sensitive");
    registry.acquire(acq({ scope: "src/api.ts", eventRevision: 1 }));
    const outcome = registry.acquire(
      acq({ lockId: "lock-2", holder: bob, scope: "./src/./api.ts", eventRevision: 2 }),
    );
    expect(outcome.contended).toBe(true);
  });

  it("case-folds scopes on case-insensitive platforms", () => {
    const registry = new LockRegistry("case-insensitive");
    registry.acquire(acq({ scope: "src/API.ts", eventRevision: 1 }));
    const outcome = registry.acquire(
      acq({ lockId: "lock-2", holder: bob, scope: "src/api.ts", eventRevision: 2 }),
    );
    expect(outcome.contended).toBe(true);
  });
});

describe("LockRegistry.release (Req 12.6–12.8)", () => {
  it("removes the lock when released by its holder (Req 12.6)", () => {
    const registry = new LockRegistry("case-sensitive");
    registry.acquire(acq({ holder: alice, eventRevision: 1 }));

    const result = registry.release({
      session,
      requester: alice,
      branch: "main",
      lockId: "lock-1",
    });

    expect(result.ok).toBe(true);
    expect(registry.winningLock(session, "src/api.ts", "file", "main")).toBeUndefined();
    expect(registry.allLocks(session)).toHaveLength(0);
  });

  it("releases by scope when no lockId is given", () => {
    const registry = new LockRegistry("case-sensitive");
    registry.acquire(acq({ holder: alice, eventRevision: 1 }));
    const result = registry.release({
      session,
      requester: alice,
      branch: "main",
      scope: "src/api.ts",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a non-holder release with NOT_LOCK_HOLDER and retains the lock (Req 12.7)", () => {
    const registry = new LockRegistry("case-sensitive");
    registry.acquire(acq({ holder: alice, eventRevision: 1 }));

    const result = registry.release({
      session,
      requester: bob,
      branch: "main",
      lockId: "lock-1",
    });

    expect(result).toEqual({ ok: false, code: "NOT_LOCK_HOLDER" });
    // Lock is retained unchanged.
    expect(registry.winningLock(session, "src/api.ts", "file", "main")?.holder).toEqual(
      alice,
    );
  });

  it("rejects release for a path with no active lock with NO_ACTIVE_LOCK (Req 12.8)", () => {
    const registry = new LockRegistry("case-sensitive");
    const result = registry.release({
      session,
      requester: alice,
      branch: "main",
      scope: "src/unknown.ts",
    });
    expect(result).toEqual({ ok: false, code: "NO_ACTIVE_LOCK" });
  });

  it("rejects release by unknown lockId with NO_ACTIVE_LOCK", () => {
    const registry = new LockRegistry("case-sensitive");
    registry.acquire(acq({ eventRevision: 1 }));
    const result = registry.release({
      session,
      requester: alice,
      branch: "main",
      lockId: "does-not-exist",
    });
    expect(result).toEqual({ ok: false, code: "NO_ACTIVE_LOCK" });
  });

  it("promotes the earliest remaining claim to winner on release", () => {
    const registry = new LockRegistry("case-sensitive");
    registry.acquire(acq({ holder: alice, lockId: "lock-1", eventRevision: 1 }));
    registry.acquire(acq({ holder: bob, lockId: "lock-2", eventRevision: 2 }));

    const result = registry.release({
      session,
      requester: alice,
      branch: "main",
      lockId: "lock-1",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.promoted?.holder).toEqual(bob);
      expect(result.promoted?.concurrent).toBe(false);
    }
    const winner = registry.winningLock(session, "src/api.ts", "file", "main");
    expect(winner?.holder).toEqual(bob);
  });
});

describe("LockRegistry session isolation (Req 10.2)", () => {
  it("keeps locks for different sessions independent", () => {
    const registry = new LockRegistry("case-sensitive");
    registry.acquire(acq({ session, eventRevision: 1 }));
    expect(registry.allLocks(otherSession)).toHaveLength(0);
    expect(registry.allLocks(session)).toHaveLength(1);
  });
});
