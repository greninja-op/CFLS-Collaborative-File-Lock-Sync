/**
 * Integration tests for the Local_API (task 9.8; Req 2.5, 25.6). Exercises the
 * loopback WebSocket transport over a real ephemeral port: token gating,
 * pre-auth rejection, loopback-only binding, and unauthorized-subscription
 * rejection.
 */

// This test's frame-collection helpers intentionally use `any` for the dynamic
// wire frames; scoping the rule off file-wide is prettier-stable (line-based
// disables shift when the formatter rewraps).
/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import {
  LocalApiServer,
  isLoopbackAddress,
  type LocalApiHandlers,
} from "../src/local-api";

const TOKEN = "test-local-auth-token";

function handlers(): LocalApiHandlers {
  return {
    request: async (method) => ({ ok: true, method }),
    subscribe: async () => ({ ok: true, subscriptionId: "sub-1" }),
  };
}

let server: LocalApiServer;
let wsUrl: string;

beforeEach(async () => {
  server = new LocalApiServer({
    token: TOKEN,
    handlers: handlers(),
    enableWebSocket: true,
    enableNamedPipe: false,
  });
  const address = await server.start();
  wsUrl = address.wsUrl!;
});

afterEach(async () => {
  await server.stop();
});

/** Open a loopback client and collect frames. */
async function open(): Promise<{
  ws: WebSocket;
  next: (predicate: (m: any) => boolean, timeoutMs?: number) => Promise<any>;
}> {
  const ws = new WebSocket(wsUrl);
  const inbox: any[] = [];
  let waiters: Array<{ p: (m: any) => boolean; resolve: (m: any) => void }> =
    [];
  ws.on("message", (data) => {
    const msg = JSON.parse(String(data));
    inbox.push(msg);
    waiters = waiters.filter((w) => {
      if (w.p(msg)) {
        w.resolve(msg);
        return false;
      }
      return true;
    });
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const next = (
    predicate: (m: any) => boolean,
    timeoutMs = 2000,
  ): Promise<any> => {
    const existing = inbox.find((m) => predicate(m));
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      waiters.push({
        p: predicate,
        resolve: (m) => {
          clearTimeout(t);
          resolve(m);
        },
      });
    });
  };
  return { ws, next };
}

describe("Local_API loopback-only binding (Req 2.5)", () => {
  it("binds the WebSocket transport to 127.0.0.1 only", () => {
    expect(wsUrl.startsWith("ws://127.0.0.1:")).toBe(true);
  });

  it("classifies non-loopback origins as rejected", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("10.0.0.5")).toBe(false);
    expect(isLoopbackAddress("192.168.1.20")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});

describe("Local_API token authentication (Req 2.5)", () => {
  it("accepts a client presenting the correct Local_Auth_Token", async () => {
    const { ws, next } = await open();
    ws.send(JSON.stringify({ type: "auth", token: TOKEN }));
    const ok = await next((m) => m.type === "auth_ok");
    expect(ok.type).toBe("auth_ok");
    ws.send(
      JSON.stringify({
        type: "request",
        id: 1,
        method: "get_connection_status",
      }),
    );
    const response = await next((m) => m.type === "response");
    expect(response.body).toEqual({
      ok: true,
      method: "get_connection_status",
    });
    ws.close();
  });

  it("rejects a client presenting a wrong token", async () => {
    const { ws, next } = await open();
    ws.send(JSON.stringify({ type: "auth", token: "wrong" }));
    const err = await next((m) => m.type === "auth_error");
    expect(err.type).toBe("auth_error");
    ws.close();
  });

  it("rejects requests before authentication", async () => {
    const { ws, next } = await open();
    ws.send(JSON.stringify({ type: "request", id: 1, method: "get_risk_map" }));
    const err = await next((m) => m.type === "auth_error");
    expect(err.type).toBe("auth_error");
    ws.close();
  });

  it("rejects a subscription before authentication (Req 25.6)", async () => {
    const { ws, next } = await open();
    ws.send(JSON.stringify({ type: "subscribe", id: 2, params: {} }));
    const err = await next((m) => m.type === "auth_error");
    expect(err.type).toBe("auth_error");
    ws.close();
  });

  it("allows a subscription after authentication", async () => {
    const { ws, next } = await open();
    ws.send(JSON.stringify({ type: "auth", token: TOKEN }));
    await next((m) => m.type === "auth_ok");
    ws.send(
      JSON.stringify({ type: "subscribe", id: 3, params: { session: {} } }),
    );
    const response = await next((m) => m.type === "response");
    expect(response.body).toEqual({ ok: true, subscriptionId: "sub-1" });
    ws.close();
  });
});

describe("Local_API startup failure (Req 2.9)", () => {
  it("rejects start() when the port cannot be bound", async () => {
    // Bind a second server to the SAME port the first one is using.
    const port = Number(wsUrl.split(":").pop());
    const conflicting = new LocalApiServer({
      token: TOKEN,
      handlers: handlers(),
      wsPort: port,
      enableWebSocket: true,
      enableNamedPipe: false,
    });
    await expect(conflicting.start()).rejects.toBeTruthy();
  });
});
