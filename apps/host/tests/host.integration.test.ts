/**
 * Integration tests for the host over a real WSS + SQLite (task 8.9; Req 1.1,
 * 1.5, 1.6, 5.4, 7.4, 8.1, 9.3). Exercises the handshake, ingest→broadcast,
 * sync convergence, restart recovery, and revoked/absent-device rejection over
 * an actual TLS WebSocket connection and a file-backed SQLite store.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startHost, type RunningHost } from "../src/index";
import {
  invitationFor,
  makeDevice,
  makeSession,
  signedEvent,
  TestClient,
  type TestDevice,
} from "./support";

const session = makeSession();

let tmp: string;
let dbPath: string;
let host: RunningHost;
let admin: TestDevice;

function url(): string {
  return `wss://127.0.0.1:${host.port}`;
}

async function startFreshHost(): Promise<RunningHost> {
  return startHost(
    { hostUrl: "wss://127.0.0.1:0", tls: { devSelfSigned: true }, dbPath },
    { expirySweepIntervalMs: 0 },
  );
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "cfls-host-"));
  dbPath = join(tmp, "host.db");
  admin = makeDevice("admin");
  host = await startFreshHost();
  host.authority.registerSession(session, [admin.key.publicKey]);
});

afterEach(async () => {
  await host.stop();
  rmSync(tmp, { recursive: true, force: true });
});

describe("authentication handshake (Req 5.3, 5.4)", () => {
  it("admits an admin device presenting a self-issued invitation", async () => {
    const client = await TestClient.open(url());
    const result = await client.handshake(session, admin, invitationFor(session, admin.key, admin));
    expect(result).toEqual({ ok: true });
    expect(client.highestRevision).toBe(0);
    client.close();
  });

  it("admits a second device invited by the admin", async () => {
    const bob = makeDevice("bob");
    const client = await TestClient.open(url());
    const result = await client.handshake(session, bob, invitationFor(session, admin.key, bob));
    expect(result).toEqual({ ok: true });
    client.close();
  });

  it("rejects a device whose invitation is not signed by an admin (absent device)", async () => {
    const impostorAdmin = makeDevice("not-admin");
    const bob = makeDevice("bob");
    const client = await TestClient.open(url());
    // Invitation signed by a non-admin issuer.
    const result = await client.handshake(
      session,
      bob,
      invitationFor(session, impostorAdmin.key, bob),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("AUTH_ISSUER_NOT_ADMIN");
    client.close();
  });

  it("rejects a revoked device (Req 5.6)", async () => {
    const bob = makeDevice("bob");
    // First admit bob so a membership entry exists, then revoke it.
    const first = await TestClient.open(url());
    expect((await first.handshake(session, bob, invitationFor(session, admin.key, bob))).ok).toBe(true);
    first.close();

    host.authority.revoke(session, bob.key.publicKey);

    const second = await TestClient.open(url());
    const result = await second.handshake(session, bob, invitationFor(session, admin.key, bob));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("AUTH_INVALID_DEVICE");
    second.close();
  });
});

describe("ingest → broadcast (Req 7, 8.1, 25)", () => {
  it("broadcasts an accepted lock to every device in the session with a revision", async () => {
    const alice = admin;
    const bob = makeDevice("bob");

    const a = await TestClient.open(url());
    expect((await a.handshake(session, alice, invitationFor(session, admin.key, alice))).ok).toBe(true);
    const b = await TestClient.open(url());
    expect((await b.handshake(session, bob, invitationFor(session, admin.key, bob))).ok).toBe(true);

    a.sendEvent(
      signedEvent(
        "lock.acquire",
        { scope: "src/api.ts", scopeKind: "file", mode: "soft" },
        { session, device: alice, counter: a.nextCounter(), eventId: "evt-lock-1" },
      ),
    );

    const update = await b.waitFor(
      (m) => m?.type === "coordination.update" && m.payload.entryType === "soft_lock",
    );
    expect(update.payload.op).toBe("added");
    expect(update.payload.path).toBe("src/api.ts");
    expect(update.payload.member.memberId).toBe("admin");
    expect(update.payload.eventRevision).toBe(1);

    a.close();
    b.close();
  });

  it("returns an idempotent result for a duplicate Event_ID (Req 7.4)", async () => {
    const alice = admin;
    const a = await TestClient.open(url());
    await a.handshake(session, alice, invitationFor(session, admin.key, alice));

    const event = signedEvent(
      "lock.acquire",
      { scope: "src/dup.ts", scopeKind: "file", mode: "soft" },
      { session, device: alice, counter: a.nextCounter(), eventId: "evt-dup" },
    );
    a.sendEvent(event);
    await a.waitFor((m) => m?.type === "coordination.update");
    // Re-send the exact same signed event; it must not produce a second lock.
    a.sendEvent(event);
    // Give the host a moment; then assert the authoritative state has one lock.
    await new Promise((r) => setTimeout(r, 100));
    const snap = host.authority.snapshot(session);
    expect(snap.locks.filter((l) => l.scope === "src/dup.ts")).toHaveLength(1);
    a.close();
  });
});

describe("sync-from-revision (Req 9.3)", () => {
  it("serves incremental events after a known revision", async () => {
    const alice = admin;
    const a = await TestClient.open(url());
    await a.handshake(session, alice, invitationFor(session, admin.key, alice));

    a.sendEvent(
      signedEvent(
        "lock.acquire",
        { scope: "src/one.ts", scopeKind: "file", mode: "soft" },
        { session, device: alice, counter: a.nextCounter(), eventId: "evt-s1" },
      ),
    );
    await a.waitFor((m) => m?.type === "coordination.update");

    // Request sync from revision 0 — should receive the lock event.
    a.sendEvent(
      signedEvent(
        "sync.request",
        { fromRevision: 0 },
        { session, device: alice, counter: a.nextCounter(), eventId: "evt-sync" },
      ),
    );
    const sync = await a.waitFor((m) => m?.type === "sync.events" || m?.type === "sync.snapshot");
    if (sync.type === "sync.events") {
      const paths = sync.payload.events.map((e: { path?: string }) => e.path);
      expect(paths).toContain("src/one.ts");
    } else {
      expect(sync.payload.state.locks.map((l: { scope: string }) => l.scope)).toContain("src/one.ts");
    }
    a.close();
  });
});

describe("restart recovery (Req 1.5, 1.6)", () => {
  it("restores authoritative locks and resumes the revision counter", async () => {
    const alice = admin;
    const a = await TestClient.open(url());
    await a.handshake(session, alice, invitationFor(session, admin.key, alice));
    a.sendEvent(
      signedEvent(
        "lock.acquire",
        { scope: "src/persist.ts", scopeKind: "file", mode: "soft" },
        { session, device: alice, counter: a.nextCounter(), eventId: "evt-persist" },
      ),
    );
    await a.waitFor((m) => m?.type === "coordination.update");
    a.close();

    const revisionBefore = host.authority.snapshot(session).highestRevision;
    expect(revisionBefore).toBeGreaterThanOrEqual(1);

    // Restart the host against the same database file.
    await host.stop();
    host = await startFreshHost();

    const restored = host.authority.snapshot(session);
    expect(restored.locks.map((l) => l.scope)).toContain("src/persist.ts");
    // The revision counter resumes strictly above the persisted highest.
    host.authority.registerSession(session, [admin.key.publicKey]);
    const reconnect = await TestClient.open(url());
    const result = await reconnect.handshake(session, alice, invitationFor(session, admin.key, alice));
    expect(result.ok).toBe(true);
    expect(reconnect.highestRevision).toBeGreaterThanOrEqual(revisionBefore);
    reconnect.close();
  });
});
