/**
 * Unit tests for the CoordinationAuthority (task 8.2, 8.3, 8.5, 8.6, 8.7;
 * Req 5, 7, 8, 9, 10.7, 13, 25, 26, 28, 29). These exercise the transport-
 * independent authority directly against an in-memory SQLite store.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentSyncCache } from "@cfls/core-state";
import type {
  AuthHelloPayload,
  DependencyGraph,
  SignedEvent,
} from "@cfls/protocol";

import { CoordinationAuthority, type AuthPrincipal } from "../src/authority";
import { signChallenge } from "../src/challenge";
import { SqliteStore, StoreError } from "../src/store";
import {
  invitationFor,
  makeDevice,
  makeSession,
  signedEvent,
  type TestDevice,
} from "./support";

const session = makeSession();
let store: SqliteStore;
let authority: CoordinationAuthority;
let admin: TestDevice;

function hello(device: TestDevice, invitationB64: string): AuthHelloPayload {
  return {
    devicePublicKey: device.key.publicKey,
    session,
    signedInvitation: invitationB64,
    version: 1,
  };
}

/** Run the full handshake in-process and return the authenticated principal. */
function authenticate(device: TestDevice): AuthPrincipal {
  const h = hello(device, invitationFor(session, admin.key, device));
  const challenge = authority.prepareChallenge(h);
  if (!challenge.ok)
    throw new Error(`prepareChallenge failed: ${challenge.code}`);
  const sig = signChallenge(challenge.nonce, device.key.privateKey);
  const result = authority.finalizeHandshake(h, challenge.nonce, sig);
  if (!result.ok) throw new Error(`finalizeHandshake failed: ${result.code}`);
  return result.principal;
}

beforeEach(() => {
  store = new SqliteStore(":memory:");
  authority = new CoordinationAuthority(store, { expiry: {} });
  admin = makeDevice("admin");
  authority.registerSession(session, [admin.key.publicKey]);
});

afterEach(() => store.close());

describe("handshake (Req 5.3–5.6, 7.6, 10.7)", () => {
  it("rejects an unsupported message-format version with FORMAT_ERROR", () => {
    const h = {
      ...hello(admin, invitationFor(session, admin.key, admin)),
      version: 999,
    };
    const result = authority.prepareChallenge(h);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("FORMAT_ERROR");
  });

  it("rejects an unknown session with AUTH_SESSION_FORBIDDEN", () => {
    const other = makeSession({ branch: "unknown" });
    const h = {
      ...hello(admin, invitationFor(session, admin.key, admin)),
      session: other,
    };
    const result = authority.prepareChallenge(h);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("AUTH_SESSION_FORBIDDEN");
  });

  it("rejects a non-admin invitation issuer with AUTH_ISSUER_NOT_ADMIN", () => {
    const notAdmin = makeDevice("intruder");
    const bob = makeDevice("bob");
    const result = authority.prepareChallenge(
      hello(bob, invitationFor(session, notAdmin.key, bob)),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("AUTH_ISSUER_NOT_ADMIN");
  });

  it("completes the challenge-response and returns the highest revision", () => {
    const principal = authenticate(admin);
    expect(principal.memberId).toBe("admin");
    expect(principal.session).toEqual(session);
  });

  it("fails the handshake on a bad challenge signature", () => {
    const h = hello(admin, invitationFor(session, admin.key, admin));
    const challenge = authority.prepareChallenge(h);
    expect(challenge.ok).toBe(true);
    if (!challenge.ok) return;
    const result = authority.finalizeHandshake(h, challenge.nonce, "AAAA");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("AUTH_INVALID_DEVICE");
  });
});

describe("ingest pipeline (Req 7, 8, 10.7, 29)", () => {
  it("assigns a monotonic revision and produces a broadcast for a lock", () => {
    const principal = authenticate(admin);
    const outcome = authority.ingest(
      principal,
      signedEvent(
        "lock.acquire",
        { scope: "src/a.ts", scopeKind: "file", mode: "soft" },
        { session, device: admin, counter: 1, eventId: "e1" },
      ),
    );
    expect(outcome.accepted).toBe(true);
    expect(outcome.eventRevision).toBe(1);
    expect(outcome.broadcasts).toHaveLength(1);
    expect(outcome.broadcasts[0]).toMatchObject({
      entryType: "soft_lock",
      op: "added",
      path: "src/a.ts",
    });
  });

  it("is idempotent for a duplicate Event_ID (Req 7.4)", () => {
    const principal = authenticate(admin);
    const event = signedEvent(
      "lock.acquire",
      { scope: "src/a.ts", scopeKind: "file", mode: "soft" },
      { session, device: admin, counter: 1, eventId: "dup" },
    );
    const first = authority.ingest(principal, event);
    const second = authority.ingest(principal, event);
    expect(first.eventRevision).toBe(1);
    expect(second.duplicateOf).toBe(1);
    expect(second.broadcasts).toHaveLength(0);
    expect(authority.snapshot(session).locks).toHaveLength(1);
  });

  it("fails closed without a partial durable mutation when the atomic commit fails", () => {
    const principal = authenticate(admin);
    const event = signedEvent(
      "lock.acquire",
      { scope: "src/atomic.ts", scopeKind: "file", mode: "soft" },
      { session, device: admin, counter: 1, eventId: "atomic-failure" },
    );
    const before = authority.snapshot(session);
    const commit = vi
      .spyOn(store, "commitMutation")
      .mockImplementationOnce(() => {
        throw new StoreError("injected write failure");
      });

    const failed = authority.ingest(principal, event);

    expect(failed).toMatchObject({
      accepted: false,
      error: "STORAGE_ERROR",
      broadcasts: [],
    });
    // The state and its externally visible revision are restored; no peer can
    // sync a phantom event that failed to become durable.
    expect(authority.snapshot(session)).toEqual(before);
    expect(store.eventsSince(session, 0)).toEqual([]);
    expect(store.hasAppliedEventId(session, "atomic-failure")).toBeNull();

    // The in-process gate/replay state may have advanced before the failed
    // transaction, so the authority must never falsely acknowledge a retry.
    const fencedRetry = authority.ingest(principal, event);
    expect(fencedRetry).toMatchObject({
      accepted: false,
      error: "STORAGE_ERROR",
    });

    commit.mockRestore();
    // A restart rebuilds from the atomically unchanged store and safely accepts
    // the original signed event rather than treating it as a duplicate.
    const restarted = new CoordinationAuthority(store, { expiry: {} });
    const acceptedAfterRestart = restarted.ingest(principal, event);
    expect(acceptedAfterRestart).toMatchObject({
      accepted: true,
      eventRevision: 1,
    });
    expect(restarted.snapshot(session).locks).toEqual([
      expect.objectContaining({ scope: "src/atomic.ts" }),
    ]);
  });

  it("rejects a replayed counter with FORMAT_ERROR leaving state unchanged (Req 7.5)", () => {
    const principal = authenticate(admin);
    authority.ingest(
      principal,
      signedEvent(
        "lock.acquire",
        { scope: "src/a.ts", scopeKind: "file", mode: "soft" },
        { session, device: admin, counter: 5, eventId: "e1" },
      ),
    );
    const replay = authority.ingest(
      principal,
      signedEvent(
        "lock.acquire",
        { scope: "src/b.ts", scopeKind: "file", mode: "soft" },
        { session, device: admin, counter: 3, eventId: "e2" },
      ),
    );
    expect(replay.accepted).toBe(false);
    expect(replay.error).toBe("FORMAT_ERROR");
    expect(authority.snapshot(session).locks).toHaveLength(1);
  });

  it("rejects an event for a mismatched session with AUTH_SESSION_FORBIDDEN (Req 10.7)", () => {
    const principal = authenticate(admin);
    const otherSession = makeSession({ branch: "feature-y" });
    const event = signedEvent(
      "lock.acquire",
      { scope: "src/a.ts", scopeKind: "file", mode: "soft" },
      { session: otherSession, device: admin, counter: 1, eventId: "e1" },
    );
    const outcome = authority.ingest(principal, event);
    expect(outcome.accepted).toBe(false);
    expect(outcome.error).toBe("AUTH_SESSION_FORBIDDEN");
  });

  it("rejects a tampered signature with AUTH_INVALID_DEVICE (Req 7.2, 7.3)", () => {
    const principal = authenticate(admin);
    const event = signedEvent(
      "lock.acquire",
      { scope: "src/a.ts", scopeKind: "file", mode: "soft" },
      { session, device: admin, counter: 1, eventId: "e1" },
    );
    // Tamper with the payload after signing.
    const tampered: SignedEvent = {
      ...event,
      envelope: {
        ...event.envelope,
        payload: { scope: "src/evil.ts", scopeKind: "file", mode: "hard" },
      },
    };
    const outcome = authority.ingest(principal, tampered);
    expect(outcome.accepted).toBe(false);
    expect(outcome.error).toBe("AUTH_INVALID_DEVICE");
  });

  it("rejects an inbound data-minimization violation with FORMAT_ERROR (Req 29.5)", () => {
    const principal = authenticate(admin);
    const event = signedEvent(
      "presence.report",
      { path: "/etc/passwd", state: "editing" },
      { session, device: admin, counter: 1, eventId: "e1" },
    );
    const outcome = authority.ingest(principal, event);
    expect(outcome.accepted).toBe(false);
    expect(outcome.error).toBe("FORMAT_ERROR");
  });
});

describe("locks, intents, overrides (Req 12, 13, 16)", () => {
  it("keeps incremental and snapshot clients on the same winning lock during contention", () => {
    const alice = authenticate(admin);
    const bob = makeDevice("bob");
    const bobPrincipal = authenticate(bob);

    const winning = authority.ingest(
      alice,
      signedEvent(
        "lock.acquire",
        { scope: "src/shared.ts", scopeKind: "file", mode: "soft" },
        { session, device: admin, counter: 1, eventId: "lock-alice" },
      ),
    );
    const losing = authority.ingest(
      bobPrincipal,
      signedEvent(
        "lock.acquire",
        { scope: "src/shared.ts", scopeKind: "file", mode: "soft" },
        { session, device: bob, counter: 1, eventId: "lock-bob" },
      ),
    );

    // The host retains Bob's concurrent claim for later promotion but only
    // projects Alice's current winner to connected clients.
    expect(losing.broadcasts).toEqual([]);
    expect(losing.accepted).toBe(true);
    expect(losing.lockConflict).toEqual({
      scope: "src/shared.ts",
      winner: {
        memberId: alice.memberId,
        eventRevision: winning.eventRevision,
      },
    });
    const incremental = new AgentSyncCache();
    incremental.applyEvents(session, [
      ...winning.broadcasts,
      ...losing.broadcasts,
    ]);
    const fromSnapshot = new AgentSyncCache();
    fromSnapshot.applySnapshot(session, authority.snapshot(session));

    expect(incremental.cachedEntries(session)).toEqual(
      fromSnapshot.cachedEntries(session),
    );
    expect(incremental.cachedEntries(session)).toEqual([
      expect.objectContaining({
        entryType: "soft_lock",
        op: "added",
        path: "src/shared.ts",
        member: {
          memberId: alice.memberId,
          deviceId: alice.deviceId,
        },
      }),
    ]);
  });

  it("rejects a release by a non-holder with NOT_LOCK_HOLDER (Req 12.7)", () => {
    const alice = authenticate(admin);
    const bob = makeDevice("bob");
    const bobPrincipal = authenticate(bob);

    authority.ingest(
      alice,
      signedEvent(
        "lock.acquire",
        { scope: "src/a.ts", scopeKind: "file", mode: "soft" },
        { session, device: admin, counter: 1, eventId: "lock-a" },
      ),
    );
    const release = authority.ingest(
      bobPrincipal,
      signedEvent(
        "lock.release",
        { scope: "src/a.ts" },
        { session, device: bob, counter: 1, eventId: "rel-a" },
      ),
    );
    expect(release.accepted).toBe(false);
    expect(release.error).toBe("NOT_LOCK_HOLDER");
  });

  it("never re-acknowledges a domain-rejected Event_ID after retry or restart", () => {
    const alice = authenticate(admin);
    const bob = makeDevice("bob");
    const bobPrincipal = authenticate(bob);
    authority.ingest(
      alice,
      signedEvent(
        "lock.acquire",
        { scope: "src/rejected-release.ts", scopeKind: "file", mode: "soft" },
        { session, device: admin, counter: 1, eventId: "rejected-owner-lock" },
      ),
    );
    const rejectedEvent = signedEvent(
      "lock.release",
      { scope: "src/rejected-release.ts" },
      { session, device: bob, counter: 1, eventId: "rejected-release" },
    );

    const rejected = authority.ingest(bobPrincipal, rejectedEvent);
    const retry = authority.ingest(bobPrincipal, rejectedEvent);

    expect(rejected).toMatchObject({
      accepted: false,
      error: "NOT_LOCK_HOLDER",
      eventRevision: 2,
    });
    expect(store.hasAppliedEventId(session, "rejected-release")).toBeNull();
    expect(retry).toMatchObject({ accepted: false, error: "FORMAT_ERROR" });

    const restarted = new CoordinationAuthority(store, { expiry: {} });
    const postRestartRetry = restarted.ingest(bobPrincipal, rejectedEvent);
    expect(postRestartRetry).toMatchObject({
      accepted: false,
      error: "FORMAT_ERROR",
    });
    expect(restarted.snapshot(session)).toMatchObject({ highestRevision: 2 });
    expect(restarted.snapshot(session).locks).toEqual([
      expect.objectContaining({ scope: "src/rejected-release.ts" }),
    ]);
  });

  it("rejects a coordination-required override with no reason (Req 13.4)", () => {
    const principal = authenticate(admin);
    const outcome = authority.ingest(
      principal,
      signedEvent(
        "lock.override",
        {
          scope: "openapi/orders.yaml",
          scopeKind: "file",
          mode: "coordination-required",
          overrideReason: "   ",
        },
        { session, device: admin, counter: 1, eventId: "ov-1" },
      ),
    );
    expect(outcome.accepted).toBe(false);
    expect(outcome.error).toBe("OVERRIDE_REASON_REQUIRED");
  });

  it("writes an audit record for an accepted override (Req 28)", () => {
    const principal = authenticate(admin);
    authority.ingest(
      principal,
      signedEvent(
        "lock.override",
        {
          scope: "openapi/orders.yaml",
          scopeKind: "file",
          mode: "coordination-required",
          overrideReason: "hotfix",
        },
        { session, device: admin, counter: 1, eventId: "ov-1" },
      ),
    );
    const audits = authority.auditRecords(session);
    const override = audits.find((a) => a.action === "override");
    expect(override).toBeDefined();
    expect(override?.overrideReason).toBe("hotfix");
  });

  it("rejects an intent update by a non-owner with NOT_OWNER (Req 16.8)", () => {
    const alice = authenticate(admin);
    const bob = makeDevice("bob");
    const bobPrincipal = authenticate(bob);

    authority.ingest(
      alice,
      signedEvent(
        "intent.declare",
        { modifyPaths: ["src/a.ts"], createPaths: [], description: "refactor" },
        { session, device: admin, counter: 1, eventId: "intent-1" },
      ),
    );
    const update = authority.ingest(
      bobPrincipal,
      signedEvent(
        "intent.update",
        {
          intentId: "intent-1",
          modifyPaths: ["src/b.ts"],
          createPaths: [],
          description: "steal",
        },
        { session, device: bob, counter: 1, eventId: "intent-upd" },
      ),
    );
    expect(update.accepted).toBe(false);
    expect(update.error).toBe("NOT_OWNER");
  });

  it("retires replaced intent paths before broadcasting the new task projection", () => {
    const principal = authenticate(admin);
    const declared = authority.ingest(
      principal,
      signedEvent(
        "intent.declare",
        {
          modifyPaths: ["src/old.ts"],
          createPaths: ["src/old.test.ts"],
          description: "Replace old endpoint",
        },
        { session, device: admin, counter: 1, eventId: "intent-1" },
      ),
    );
    const updated = authority.ingest(
      principal,
      signedEvent(
        "intent.update",
        {
          intentId: "intent-1",
          modifyPaths: ["src/new.ts"],
          createPaths: ["src/new.test.ts"],
          description: "Implement new endpoint",
        },
        { session, device: admin, counter: 2, eventId: "intent-upd" },
      ),
    );

    expect(updated.accepted).toBe(true);
    expect(updated.broadcasts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entryType: "intent",
          op: "removed",
          path: "src/old.ts",
          intent: {
            intentId: "intent-1",
            description: "Replace old endpoint",
          },
        }),
        expect.objectContaining({
          entryType: "planned_file_creation",
          op: "removed",
          path: "src/old.test.ts",
        }),
        expect.objectContaining({
          entryType: "intent",
          op: "added",
          path: "src/new.ts",
          intent: {
            intentId: "intent-1",
            description: "Implement new endpoint",
          },
        }),
      ]),
    );

    const cache = new AgentSyncCache();
    cache.applyEvents(session, declared.broadcasts);
    cache.applyEvents(session, updated.broadcasts);
    expect(
      cache
        .cachedEntries(session)
        .map((entry) => entry.path)
        .sort(),
    ).toEqual(["src/new.test.ts", "src/new.ts"]);
  });
});

describe("path changes (Req 30)", () => {
  it("moves both declared roles when one intent names a path as modify and create", () => {
    const principal = authenticate(admin);
    const declared = authority.ingest(
      principal,
      signedEvent(
        "intent.declare",
        {
          modifyPaths: ["src/old.ts"],
          createPaths: ["src/old.ts"],
          description: "Replace generated endpoint",
        },
        { session, device: admin, counter: 1, eventId: "intent-overlap" },
      ),
    );
    const renamed = authority.ingest(
      principal,
      signedEvent(
        "path.renamed",
        { fromPath: "src/old.ts", toPath: "src/new.ts" },
        { session, device: admin, counter: 2, eventId: "rename-overlap" },
      ),
    );

    expect(renamed.accepted).toBe(true);
    expect(renamed.broadcasts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entryType: "intent",
          op: "removed",
          path: "src/old.ts",
        }),
        expect.objectContaining({
          entryType: "intent",
          op: "added",
          path: "src/new.ts",
        }),
        expect.objectContaining({
          entryType: "planned_file_creation",
          op: "removed",
          path: "src/old.ts",
        }),
        expect.objectContaining({
          entryType: "planned_file_creation",
          op: "added",
          path: "src/new.ts",
        }),
      ]),
    );

    const cache = new AgentSyncCache();
    cache.applyEvents(session, declared.broadcasts);
    cache.applyEvents(session, renamed.broadcasts);
    expect(
      cache
        .cachedEntries(session)
        .map((entry) => `${entry.entryType}:${entry.path}`)
        .sort(),
    ).toEqual(["intent:src/new.ts", "planned_file_creation:src/new.ts"]);
  });

  it("transfers a lock from the old path to the new path on rename (Req 30.2)", () => {
    const principal = authenticate(admin);
    authority.ingest(
      principal,
      signedEvent(
        "lock.acquire",
        { scope: "src/a.ts", scopeKind: "file", mode: "soft" },
        { session, device: admin, counter: 1, eventId: "lock-a" },
      ),
    );

    const renamed = authority.ingest(
      principal,
      signedEvent(
        "path.renamed",
        { fromPath: "src/a.ts", toPath: "src/b.ts" },
        { session, device: admin, counter: 2, eventId: "rename-1" },
      ),
    );
    expect(renamed.accepted).toBe(true);
    expect(renamed.broadcasts).toContainEqual(
      expect.objectContaining({
        entryType: "soft_lock",
        op: "removed",
        path: "src/a.ts",
      }),
    );
    expect(renamed.broadcasts).toContainEqual(
      expect.objectContaining({
        entryType: "soft_lock",
        op: "added",
        path: "src/b.ts",
      }),
    );

    const locks = authority.snapshot(session).locks;
    expect(locks.map((l) => l.scope)).toContain("src/b.ts");
    expect(locks.map((l) => l.scope)).not.toContain("src/a.ts");
  });

  it("releases the deleting member's lock on delete and broadcasts the removal (Req 30.5)", () => {
    const principal = authenticate(admin);
    authority.ingest(
      principal,
      signedEvent(
        "lock.acquire",
        { scope: "src/gone.ts", scopeKind: "file", mode: "soft" },
        { session, device: admin, counter: 1, eventId: "lock-g" },
      ),
    );

    const deleted = authority.ingest(
      principal,
      signedEvent(
        "path.deleted",
        { path: "src/gone.ts" },
        { session, device: admin, counter: 2, eventId: "del-1" },
      ),
    );
    expect(deleted.accepted).toBe(true);
    expect(deleted.broadcasts).toContainEqual(
      expect.objectContaining({
        entryType: "soft_lock",
        op: "removed",
        path: "src/gone.ts",
      }),
    );
    expect(authority.snapshot(session).locks.map((l) => l.scope)).not.toContain(
      "src/gone.ts",
    );
  });

  it("retires a matching Planned_File_Creation when the file is actually created (Req 17.2)", () => {
    const principal = authenticate(admin);
    authority.ingest(
      principal,
      signedEvent(
        "intent.declare",
        {
          modifyPaths: [],
          createPaths: ["src/new.ts"],
          description: "create it",
        },
        { session, device: admin, counter: 1, eventId: "intent-new" },
      ),
    );

    const created = authority.ingest(
      principal,
      signedEvent(
        "file.created",
        { path: "src/new.ts" },
        { session, device: admin, counter: 2, eventId: "created-1" },
      ),
    );
    expect(created.accepted).toBe(true);
    expect(created.broadcasts).toContainEqual(
      expect.objectContaining({
        entryType: "planned_file_creation",
        op: "removed",
        path: "src/new.ts",
      }),
    );
    const intents = authority.snapshot(session).intents;
    const stillPlanned = intents.some((i) =>
      i.createPaths.some((c) => c.path === "src/new.ts"),
    );
    expect(stillPlanned).toBe(false);
  });
});

describe("dependency graph (Req 19, 20)", () => {
  it("persists an uploaded dep.snapshot and exposes it for distribution", () => {
    const principal = authenticate(admin);
    const graph: DependencyGraph = {
      snapshot: {
        sessionId: session,
        graphVersion: 1,
        analyzerVersion: "test",
      },
      packages: [],
      modules: [
        {
          sourceFile: "src/a.ts",
          edges: [
            {
              from: "src/a.ts",
              to: "src/b.ts",
              kind: "runtime_import",
              confidence: "high",
            },
          ],
        },
      ],
      contracts: [],
    };
    const outcome = authority.ingest(
      principal,
      signedEvent(
        "dep.snapshot",
        { graph },
        { session, device: admin, counter: 1, eventId: "dep-1" },
      ),
    );
    expect(outcome.accepted).toBe(true);

    const stored = authority.dependencyGraph(session);
    expect(stored).not.toBeNull();
    expect(stored?.modules[0]?.edges[0]).toMatchObject({
      from: "src/a.ts",
      to: "src/b.ts",
    });
  });

  it("survives a restart by reloading the persisted graph from the store", () => {
    const principal = authenticate(admin);
    const graph: DependencyGraph = {
      snapshot: {
        sessionId: session,
        graphVersion: 1,
        analyzerVersion: "test",
      },
      packages: [],
      modules: [
        {
          sourceFile: "src/x.ts",
          edges: [
            {
              from: "src/x.ts",
              to: "src/y.ts",
              kind: "runtime_import",
              confidence: "high",
            },
          ],
        },
      ],
      contracts: [],
    };
    authority.ingest(
      principal,
      signedEvent(
        "dep.snapshot",
        { graph },
        { session, device: admin, counter: 1, eventId: "dep-x" },
      ),
    );

    // A fresh authority over the SAME store must reload the graph (Req 1.5).
    const reloaded = new CoordinationAuthority(store, { expiry: {} });
    reloaded.registerSession(session, [admin.key.publicKey]);
    const stored = reloaded.dependencyGraph(session);
    expect(stored?.modules[0]?.edges[0]).toMatchObject({
      from: "src/x.ts",
      to: "src/y.ts",
    });
  });
});

describe("sync-from-revision (Req 9)", () => {
  it("serves incremental events after a revision", () => {
    const principal = authenticate(admin);
    authority.ingest(
      principal,
      signedEvent(
        "lock.acquire",
        { scope: "src/a.ts", scopeKind: "file", mode: "soft" },
        { session, device: admin, counter: 1, eventId: "e1" },
      ),
    );
    const response = authority.syncFrom(session, 0);
    expect(response.kind).toBe("events");
    if (response.kind === "events") {
      expect(response.events.map((e) => e.path)).toContain("src/a.ts");
    }
  });

  it("forces a snapshot for an older cursor after restart when the volatile log is empty", () => {
    const principal = authenticate(admin);
    const first = authority.ingest(
      principal,
      signedEvent(
        "lock.acquire",
        { scope: "src/one.ts", scopeKind: "file", mode: "soft" },
        { session, device: admin, counter: 1, eventId: "restart-one" },
      ),
    );
    const second = authority.ingest(
      principal,
      signedEvent(
        "lock.acquire",
        { scope: "src/two.ts", scopeKind: "file", mode: "soft" },
        { session, device: admin, counter: 2, eventId: "restart-two" },
      ),
    );
    expect(first.eventRevision).toBe(1);
    expect(second.eventRevision).toBe(2);

    // A reconnecting client has cached the first event, then the host process
    // restarts. Its fresh in-memory event log must not claim an empty suffix is
    // a complete answer for cursor 1.
    const reloaded = new CoordinationAuthority(store, { expiry: {} });
    const response = reloaded.syncFrom(session, first.eventRevision ?? 0);
    expect(response.kind).toBe("snapshot");
    if (response.kind !== "snapshot") {
      return;
    }

    const client = new AgentSyncCache();
    client.applyEvents(session, first.broadcasts);
    client.applySync(session, response);
    expect(client.highestApplied(session)).toBe(2);
    expect(
      client
        .cachedEntries(session)
        .map((entry) => entry.path)
        .sort(),
    ).toEqual(["src/one.ts", "src/two.ts"]);

    const next = reloaded.ingest(
      principal,
      signedEvent(
        "lock.acquire",
        { scope: "src/three.ts", scopeKind: "file", mode: "soft" },
        { session, device: admin, counter: 3, eventId: "restart-three" },
      ),
    );
    expect(next.eventRevision).toBe(3);
  });
});

describe("heartbeats & expiry (Req 26)", () => {
  it("expires locks held by a device whose heartbeat is stale", () => {
    const principal = authenticate(admin);
    authority.ingest(
      principal,
      signedEvent(
        "lock.acquire",
        { scope: "src/a.ts", scopeKind: "file", mode: "soft" },
        { session, device: admin, counter: 1, eventId: "e1" },
      ),
    );
    authority.recordHeartbeat(session, principal.deviceId, 1_000);
    expect(authority.snapshot(session).locks).toHaveLength(1);

    // Sweep well past the default 45s lock-expiry interval.
    const removals = authority.sweepExpiry(session, 1_000 + 60_000);
    expect(removals.length).toBeGreaterThan(0);
    expect(authority.snapshot(session).locks).toHaveLength(0);
  });

  it("does not publish or lose expiry state when its durable commit fails", () => {
    const principal = authenticate(admin);
    authority.ingest(
      principal,
      signedEvent(
        "lock.acquire",
        { scope: "src/expiry-atomic.ts", scopeKind: "file", mode: "soft" },
        { session, device: admin, counter: 1, eventId: "expiry-atomic-lock" },
      ),
    );
    const at = Date.now();
    authority.recordHeartbeat(session, principal.deviceId, at);
    const before = authority.snapshot(session);
    const commit = vi
      .spyOn(store, "commitExpiry")
      .mockImplementationOnce(() => {
        throw new StoreError("injected expiry persistence failure");
      });

    const removals = authority.sweepExpiry(session, at + 60_000);

    expect(removals).toEqual([]);
    expect(authority.snapshot(session)).toEqual(before);
    expect(store.auditRecords(session)).toEqual([]);

    // A failed sweep fences both foreground and background mutations until a
    // restart can reconstruct the authoritative state from its prior snapshot.
    const fenced = authority.ingest(
      principal,
      signedEvent(
        "presence.report",
        { path: "src/expiry-atomic.ts", state: "editing" },
        { session, device: admin, counter: 2, eventId: "expiry-fenced" },
      ),
    );
    expect(fenced).toMatchObject({
      accepted: false,
      error: "STORAGE_ERROR",
    });

    commit.mockRestore();
    const reloaded = new CoordinationAuthority(store, { expiry: {} });
    expect(reloaded.snapshot(session)).toEqual(before);
    expect(reloaded.sweepExpiry(session, Date.now() + 60_000)).toContainEqual(
      expect.objectContaining({
        entryType: "soft_lock",
        op: "removed",
        path: "src/expiry-atomic.ts",
      }),
    );
  });

  it("ends and persists active presence when a device disappears abruptly", () => {
    const principal = authenticate(admin);
    const reported = authority.ingest(
      principal,
      signedEvent(
        "presence.report",
        { path: "src/abrupt-presence.ts", state: "editing" },
        {
          session,
          device: admin,
          counter: 1,
          eventId: "abrupt-presence-start",
        },
      ),
    );
    expect(reported).toMatchObject({ accepted: true, eventRevision: 1 });
    expect(authority.snapshot(session).presence).toEqual([
      expect.objectContaining({
        path: "src/abrupt-presence.ts",
        state: "editing",
      }),
    ]);

    authority.recordHeartbeat(session, principal.deviceId, 1_000);
    const removals = authority.sweepExpiry(session, 1_000 + 60_000);

    expect(removals).toContainEqual(
      expect.objectContaining({
        entryType: "presence",
        op: "removed",
        path: "src/abrupt-presence.ts",
        member: {
          memberId: principal.memberId,
          deviceId: principal.deviceId,
        },
        eventRevision: 2,
      }),
    );
    expect(authority.snapshot(session).presence).toEqual([
      expect.objectContaining({
        path: "src/abrupt-presence.ts",
        state: "stopped",
        eventRevision: 2,
      }),
    ]);

    const reloaded = new CoordinationAuthority(store, { expiry: {} });
    expect(
      reloaded
        .snapshot(session)
        .presence.filter((presence) => presence.state !== "stopped"),
    ).toEqual([]);
  });

  it("gives recovered state a bounded heartbeat grace period rather than retaining dead work forever", () => {
    const principal = authenticate(admin);
    authority.ingest(
      principal,
      signedEvent(
        "lock.acquire",
        { scope: "src/recovered-dead.ts", scopeKind: "file", mode: "soft" },
        { session, device: admin, counter: 1, eventId: "recovered-dead" },
      ),
    );

    // The original process had no heartbeat for this device. Recovery seeds a
    // short liveness baseline, so the restored lock survives startup but is
    // released after the normal expiry interval unless the agent reconnects.
    const reloaded = new CoordinationAuthority(store, { expiry: {} });
    expect(reloaded.snapshot(session).locks).toHaveLength(1);
    const removals = reloaded.sweepExpiry(session, Date.now() + 60_000);
    expect(removals).toContainEqual(
      expect.objectContaining({
        entryType: "soft_lock",
        op: "removed",
        path: "src/recovered-dead.ts",
      }),
    );
    expect(reloaded.snapshot(session).locks).toHaveLength(0);
  });
});
