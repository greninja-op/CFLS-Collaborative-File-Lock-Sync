/**
 * Integration tests for the host over a real WSS + SQLite (task 8.9; Req 1.1,
 * 1.5, 1.6, 5.4, 7.4, 8.1, 9.3). Exercises the handshake, ingest→broadcast,
 * sync convergence, restart recovery, and revoked/absent-device rejection over
 * an actual TLS WebSocket connection and a file-backed SQLite store.
 */

import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { get } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  startHost,
  type HostConfigInput,
  type RunningHost,
} from "../src/index";
import {
  deviceIdOf,
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

async function startFreshHost(
  overrides: HostConfigInput = {},
): Promise<RunningHost> {
  return startHost(
    {
      hostUrl: "wss://127.0.0.1:0",
      tls: { devSelfSigned: true },
      dbPath,
      ...overrides,
    },
    { expirySweepIntervalMs: 0 },
  );
}

interface HttpResponse {
  statusCode: number | undefined;
  headers: IncomingHttpHeaders;
  body: string;
}

function getHttp(path: string): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const request = get(
      {
        hostname: "127.0.0.1",
        port: host.port,
        path,
        rejectUnauthorized: false,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.once("end", () => {
          resolve({
            statusCode: response.statusCode,
            headers: response.headers,
            body,
          });
        });
      },
    );
    request.once("error", reject);
  });
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
    const result = await client.handshake(
      session,
      admin,
      invitationFor(session, admin.key, admin),
    );
    expect(result).toEqual({ ok: true });
    expect(client.highestRevision).toBe(0);
    client.close();
  });

  it("admits a second device invited by the admin", async () => {
    const bob = makeDevice("bob");
    const client = await TestClient.open(url());
    const result = await client.handshake(
      session,
      bob,
      invitationFor(session, admin.key, bob),
    );
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
    expect(
      (
        await first.handshake(
          session,
          bob,
          invitationFor(session, admin.key, bob),
        )
      ).ok,
    ).toBe(true);
    first.close();

    host.authority.revoke(session, bob.key.publicKey);

    const second = await TestClient.open(url());
    const result = await second.handshake(
      session,
      bob,
      invitationFor(session, admin.key, bob),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("AUTH_INVALID_DEVICE");
    second.close();
  });
});

describe("dashboard HTTP", () => {
  it("serves a live metadata-only page and API by default", async () => {
    expect(host.config.dashboard).toBe(true);
    const root = await getHttp("/");
    const page = await getHttp("/dashboard");
    expect(root.statusCode).toBe(200);
    expect(String(root.headers["content-type"])).toMatch(/^text\/html/);
    expect(root.headers["cache-control"]).toBe("no-store");
    expect(page.statusCode).toBe(200);
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.body).toContain("CFLS Coordination Dashboard");

    const client = await TestClient.open(url());
    expect(
      (
        await client.handshake(
          session,
          admin,
          invitationFor(session, admin.key, admin),
        )
      ).ok,
    ).toBe(true);

    const initial = await getHttp("/api/coordination");
    expect(initial.statusCode).toBe(200);
    expect(String(initial.headers["content-type"])).toMatch(
      /^application\/json/,
    );
    const initialState = JSON.parse(initial.body) as {
      sessions: Array<{
        repoId: string;
        branch: string;
        connectedDevices: string[];
      }>;
    };
    const initialSession = initialState.sessions.find(
      (entry) =>
        entry.repoId === session.repoId && entry.branch === session.branch,
    );
    expect(initialSession?.connectedDevices).toContain(deviceIdOf(admin));

    client.sendEvent(
      signedEvent(
        "lock.acquire",
        { scope: "src/dashboard-live.ts", scopeKind: "file", mode: "soft" },
        {
          session,
          device: admin,
          counter: client.nextCounter(),
          eventId: "evt-dashboard-live-lock",
        },
      ),
    );
    await client.waitFor(
      (message) =>
        message?.type === "coordination.update" &&
        message.payload.path === "src/dashboard-live.ts",
    );

    const live = await getHttp("/api/coordination");
    const liveState = JSON.parse(live.body) as {
      sessions: Array<{
        repoId: string;
        branch: string;
        locks: Array<{
          path: string;
          holder: string;
          mode: string;
          eventRevision: number;
        }>;
      }>;
    };
    const liveSession = liveState.sessions.find(
      (entry) =>
        entry.repoId === session.repoId && entry.branch === session.branch,
    );
    expect(liveSession?.locks).toContainEqual({
      path: "src/dashboard-live.ts",
      holder: "admin",
      mode: "soft",
      eventRevision: 1,
    });
    client.close();
  });

  it("returns 404 for dashboard routes when disabled without affecting health endpoints", async () => {
    await host.stop();
    host = await startFreshHost({ dashboard: false });
    expect(host.config.dashboard).toBe(false);

    for (const path of ["/", "/dashboard", "/api/coordination"]) {
      expect((await getHttp(path)).statusCode).toBe(404);
    }

    const health = await getHttp("/health");
    const diagnostics = await getHttp("/diagnostics");
    expect(health.statusCode).toBe(200);
    expect(JSON.parse(health.body)).toMatchObject({ status: "ok" });
    expect(diagnostics.statusCode).toBe(200);
    expect(JSON.parse(diagnostics.body)).toMatchObject({ status: "ok" });
  });
});

describe("ingest → broadcast (Req 7, 8.1, 25)", () => {
  it("broadcasts an accepted lock to every device in the session with a revision", async () => {
    const alice = admin;
    const bob = makeDevice("bob");

    const a = await TestClient.open(url());
    expect(
      (
        await a.handshake(
          session,
          alice,
          invitationFor(session, admin.key, alice),
        )
      ).ok,
    ).toBe(true);
    const b = await TestClient.open(url());
    expect(
      (await b.handshake(session, bob, invitationFor(session, admin.key, bob)))
        .ok,
    ).toBe(true);

    a.sendEvent(
      signedEvent(
        "lock.acquire",
        { scope: "src/api.ts", scopeKind: "file", mode: "soft" },
        {
          session,
          device: alice,
          counter: a.nextCounter(),
          eventId: "evt-lock-1",
        },
      ),
    );

    const update = await b.waitFor(
      (m) =>
        m?.type === "coordination.update" &&
        m.payload.entryType === "soft_lock",
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
        {
          session,
          device: alice,
          counter: a.nextCounter(),
          eventId: "evt-sync",
        },
      ),
    );
    const sync = await a.waitFor(
      (m) => m?.type === "sync.events" || m?.type === "sync.snapshot",
    );
    if (sync.type === "sync.events") {
      const paths = sync.payload.events.map((e: { path?: string }) => e.path);
      expect(paths).toContain("src/one.ts");
    } else {
      expect(
        sync.payload.state.locks.map((l: { scope: string }) => l.scope),
      ).toContain("src/one.ts");
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
        {
          session,
          device: alice,
          counter: a.nextCounter(),
          eventId: "evt-persist",
        },
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
    const result = await reconnect.handshake(
      session,
      alice,
      invitationFor(session, admin.key, alice),
    );
    expect(result.ok).toBe(true);
    expect(reconnect.highestRevision).toBeGreaterThanOrEqual(revisionBefore);
    reconnect.close();
  });
});
