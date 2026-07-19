/**
 * Unit tests for {@link LocalApiClient} — Local_API-only connectivity and
 * heartbeats (task 11.1, 11.5; Req 3.1, 26.6). Exercised entirely against an
 * in-memory fake transport + scheduler, with no running agent or real timers.
 */

import { describe, expect, it } from "vitest";

import { HEARTBEAT_METHOD, EDITOR_EVENT_METHOD } from "./frames";
import { LocalApiClient, type Scheduler } from "./local-api-client";
import { isLoopbackUrl } from "./transport";
import type { FrameTransport } from "./transport";

/** A fake {@link FrameTransport} capturing sent frames and injecting inbound ones. */
class FakeTransport implements FrameTransport {
  sent: unknown[] = [];
  private messageHandler: ((raw: string) => void) | undefined;
  private closeHandler: (() => void) | undefined;
  private open = true;

  send(frame: unknown): void {
    this.sent.push(frame);
  }
  onMessage(handler: (raw: string) => void): void {
    this.messageHandler = handler;
  }
  onOpen(): void {
    /* not needed for these tests */
  }
  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }
  isOpen(): boolean {
    return this.open;
  }
  close(): void {
    this.open = false;
    this.closeHandler?.();
  }
  inject(frame: unknown): void {
    this.messageHandler?.(JSON.stringify(frame));
  }
  /** Frames sent of `type: "request"` for a given method. */
  requestsFor(method: string): unknown[] {
    return this.sent.filter(
      (f) =>
        typeof f === "object" &&
        f !== null &&
        (f as { type?: string }).type === "request" &&
        (f as { method?: string }).method === method,
    );
  }
}

/** A deterministic {@link Scheduler}: nothing fires unless explicitly triggered. */
class FakeScheduler implements Scheduler {
  private seq = 0;
  entries: { handle: number; handler: () => void; ms: number; cleared: boolean }[] = [];

  setInterval(handler: () => void, ms: number): unknown {
    const handle = ++this.seq;
    this.entries.push({ handle, handler, ms, cleared: false });
    return handle;
  }
  clearInterval(handle: unknown): void {
    const entry = this.entries.find((e) => e.handle === handle);
    if (entry !== undefined) {
      entry.cleared = true;
    }
  }
  /** Fire every live interval registered with the given period. */
  fire(ms: number): void {
    for (const entry of this.entries) {
      if (!entry.cleared && entry.ms === ms) {
        entry.handler();
      }
    }
  }
}

function makeClient(overrides?: { heartbeatIntervalMs?: number }): {
  client: LocalApiClient;
  transport: FakeTransport;
  scheduler: FakeScheduler;
} {
  const transport = new FakeTransport();
  const scheduler = new FakeScheduler();
  const client = new LocalApiClient({
    transport,
    token: "tok-123",
    scheduler,
    heartbeatIntervalMs: overrides?.heartbeatIntervalMs ?? 10_000,
    requestTimeoutMs: 5_000,
  });
  return { client, transport, scheduler };
}

describe("isLoopbackUrl (Req 3.1)", () => {
  it("accepts loopback URLs only", () => {
    expect(isLoopbackUrl("ws://127.0.0.1:8750")).toBe(true);
    expect(isLoopbackUrl("ws://localhost:9000")).toBe(true);
    expect(isLoopbackUrl("ws://[::1]:9000")).toBe(true);
    expect(isLoopbackUrl("wss://coord.company.com")).toBe(false);
    expect(isLoopbackUrl("ws://10.0.0.5:8750")).toBe(false);
  });
});

describe("LocalApiClient authentication (Req 2.5, 3.1)", () => {
  it("sends the auth token and resolves on auth_ok", async () => {
    const { client, transport } = makeClient();
    const pending = client.authenticate();
    expect(transport.sent[0]).toEqual({ type: "auth", token: "tok-123" });

    transport.inject({ type: "auth_ok" });
    await expect(pending).resolves.toBeUndefined();
    expect(client.isAuthenticated()).toBe(true);
  });

  it("rejects on auth_error", async () => {
    const { client, transport } = makeClient();
    const pending = client.authenticate();
    transport.inject({ type: "auth_error", message: "bad token" });
    await expect(pending).rejects.toThrow(/bad token/);
    expect(client.isAuthenticated()).toBe(false);
  });
});

describe("LocalApiClient request/response correlation", () => {
  it("resolves a request with the correlated response body", async () => {
    const { client, transport } = makeClient();
    await authAndSettle(client, transport);

    const pending = client.request("get_risk_map", { session: { repoId: "r" } });
    const frame = transport.sent.at(-1) as { type: string; id: number; method: string };
    expect(frame.type).toBe("request");
    expect(frame.method).toBe("get_risk_map");

    const body = { ok: true, data: { paths: [] } };
    transport.inject({ type: "response", id: frame.id, body });
    await expect(pending).resolves.toEqual(body);
  });

  it("streams pushed updates to subscription listeners", async () => {
    const { client, transport } = makeClient();
    await authAndSettle(client, transport);

    const received: unknown[] = [];
    const pending = client.subscribe({ session: { repoId: "r" } }, (u) => received.push(u));
    const frame = transport.sent.at(-1) as { id: number };
    transport.inject({ type: "response", id: frame.id, body: { ok: true, data: { subscriptionId: "s1" } } });
    await pending;

    transport.inject({ type: "update", payload: { entryType: "soft_lock", op: "added" } });
    transport.inject({ type: "update", payload: { entryType: "presence", op: "added" } });
    expect(received).toHaveLength(2);
  });

  it("rejects pending requests when the connection closes", async () => {
    const { client, transport } = makeClient();
    await authAndSettle(client, transport);
    const pending = client.request("get_connection_status", {});
    transport.close();
    await expect(pending).rejects.toThrow(/closed/);
  });
});

describe("LocalApiClient heartbeats (Req 26.6)", () => {
  it("sends periodic heartbeats to the agent after authenticating", async () => {
    const { client, transport, scheduler } = makeClient({ heartbeatIntervalMs: 10_000 });
    await authAndSettle(client, transport);

    expect(transport.requestsFor(HEARTBEAT_METHOD)).toHaveLength(0);
    scheduler.fire(10_000); // one heartbeat tick
    scheduler.fire(10_000); // another tick
    expect(transport.requestsFor(HEARTBEAT_METHOD)).toHaveLength(2);
  });

  it("does not send heartbeats before authentication", () => {
    const { client, scheduler, transport } = makeClient({ heartbeatIntervalMs: 10_000 });
    // startHeartbeats guards on authentication; firing a stray tick sends nothing.
    client.startHeartbeats();
    scheduler.fire(10_000);
    expect(transport.requestsFor(HEARTBEAT_METHOD)).toHaveLength(0);
  });
});

describe("LocalApiClient editor-event forwarding (Req 3.2)", () => {
  it("sends an editor_event request frame", async () => {
    const { client, transport } = makeClient();
    await authAndSettle(client, transport);
    client.sendEditorEvent({ kind: "file_saved", path: "src/a.ts", at: Date.now() });
    const frames = transport.requestsFor(EDITOR_EVENT_METHOD) as {
      params: { kind: string; path: string };
    }[];
    expect(frames).toHaveLength(1);
    expect(frames[0]?.params.kind).toBe("file_saved");
  });
});

/** Authenticate the client and let the auth_ok microtask settle. */
async function authAndSettle(client: LocalApiClient, transport: FakeTransport): Promise<void> {
  const pending = client.authenticate();
  transport.inject({ type: "auth_ok" });
  await pending;
}
