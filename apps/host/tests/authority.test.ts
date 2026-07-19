/**
 * Unit tests for the CoordinationAuthority (task 8.2, 8.3, 8.5, 8.6, 8.7;
 * Req 5, 7, 8, 9, 10.7, 13, 25, 26, 28, 29). These exercise the transport-
 * independent authority directly against an in-memory SQLite store.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuthHelloPayload, SignedEvent } from "@cfls/protocol";

import { CoordinationAuthority, type AuthPrincipal } from "../src/authority";
import { signChallenge } from "../src/challenge";
import { SqliteStore } from "../src/store";
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
  if (!challenge.ok) throw new Error(`prepareChallenge failed: ${challenge.code}`);
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
    const h = { ...hello(admin, invitationFor(session, admin.key, admin)), version: 999 };
    const result = authority.prepareChallenge(h);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("FORMAT_ERROR");
  });

  it("rejects an unknown session with AUTH_SESSION_FORBIDDEN", () => {
    const other = makeSession({ branch: "unknown" });
    const h = { ...hello(admin, invitationFor(session, admin.key, admin)), session: other };
    const result = authority.prepareChallenge(h);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("AUTH_SESSION_FORBIDDEN");
  });

  it("rejects a non-admin invitation issuer with AUTH_ISSUER_NOT_ADMIN", () => {
    const notAdmin = makeDevice("intruder");
    const bob = makeDevice("bob");
    const result = authority.prepareChallenge(hello(bob, invitationFor(session, notAdmin.key, bob)));
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
    expect(outcome.broadcasts[0]).toMatchObject({ entryType: "soft_lock", op: "added", path: "src/a.ts" });
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
      envelope: { ...event.envelope, payload: { scope: "src/evil.ts", scopeKind: "file", mode: "hard" } },
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

  it("rejects a coordination-required override with no reason (Req 13.4)", () => {
    const principal = authenticate(admin);
    const outcome = authority.ingest(
      principal,
      signedEvent(
        "lock.override",
        { scope: "openapi/orders.yaml", scopeKind: "file", mode: "coordination-required", overrideReason: "   " },
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
        { scope: "openapi/orders.yaml", scopeKind: "file", mode: "coordination-required", overrideReason: "hotfix" },
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
        { intentId: "intent-1", modifyPaths: ["src/b.ts"], createPaths: [], description: "steal" },
        { session, device: bob, counter: 1, eventId: "intent-upd" },
      ),
    );
    expect(update.accepted).toBe(false);
    expect(update.error).toBe("NOT_OWNER");
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
});
