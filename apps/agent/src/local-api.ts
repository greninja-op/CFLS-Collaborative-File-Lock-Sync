/**
 * The Local_API: the loopback-only channel between the Editor_Extension /
 * AI_Agent and the CoordinationAgent (task 9.2; Req 2.4, 2.5, 2.9, 25.6;
 * design §3.3, §8.3).
 *
 * Windows-first the transport is a **named pipe**; on every OS an authenticated
 * **loopback WebSocket** fallback is available. Both require a per-session
 * {@link LocalAuthToken} presented before any other request (Req 2.5); the
 * WebSocket listener binds to `127.0.0.1` only and additionally rejects any
 * connection whose remote address is not loopback (Req 2.5). Subscriptions from
 * unauthenticated clients are rejected (Req 25.6). If the server cannot bind, it
 * emits a startup error and refuses clients (Req 2.9).
 *
 * The transport is deliberately thin: it authenticates, then dispatches
 * `request`/`subscribe` frames to injected handlers (wired by the agent to the
 * {@link AgentCoordinationPort}). It never speaks to the CoordinationHost.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer as createNetServer,
  type Server as NetServer,
  type Socket,
} from "node:net";

import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage } from "node:http";

/** A per-session Local_Auth_Token gating all Local_API clients (Req 2.5). */
export type LocalAuthToken = string;

/** Generate a fresh, unguessable per-session Local_Auth_Token. */
export function generateLocalAuthToken(): LocalAuthToken {
  return randomBytes(32).toString("base64url");
}

/** Constant-time token comparison (avoids timing side-channels). */
export function tokensMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/** Loopback address predicate for non-loopback origin rejection (Req 2.5). */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) {
    return false;
  }
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1" ||
    address === "localhost"
  );
}

/** A dispatched request result: relayed verbatim to the client. */
export type LocalResponseBody = unknown;

/** Handlers the agent wires to the port. */
export interface LocalApiHandlers {
  /** Dispatch a non-subscription request (a tool/query/mutation). */
  request: (method: string, params: unknown) => Promise<LocalResponseBody>;
  /**
   * Register a coordination-update subscription for an authenticated client.
   * `push` streams updates to that client. Returns the response body (with a
   * subscriptionId) or an error body when the subscription is rejected (Req 25.6).
   */
  subscribe: (
    params: unknown,
    push: (update: unknown) => void,
  ) => Promise<LocalResponseBody>;
  /**
   * Dispose a successfully registered subscription when its local connection
   * closes. Optional for backwards-compatible, request-only Local_API users.
   */
  unsubscribe?: (subscriptionId: string) => void | Promise<void>;
}

/** Options for a {@link LocalApiServer}. */
export interface LocalApiServerOptions {
  /** The per-session Local_Auth_Token every client must present (Req 2.5). */
  token: LocalAuthToken;
  handlers: LocalApiHandlers;
  /** Loopback WebSocket port; 0 (default) asks the OS for an ephemeral port. */
  wsPort?: number;
  /** Enable the loopback WebSocket transport (default true). */
  enableWebSocket?: boolean;
  /** Windows named-pipe name (without the `\\.\pipe\` prefix). */
  pipeName?: string;
  /** Enable the named-pipe transport (default: true on win32, false elsewhere). */
  enableNamedPipe?: boolean;
}

/** Where the Local_API is listening, for clients to connect. */
export interface LocalApiAddress {
  /** The bound loopback WebSocket URL, when the WS transport is enabled. */
  wsUrl?: string;
  /** The full named-pipe path, when the pipe transport is enabled. */
  pipePath?: string;
}

/** A successfully registered, per-connection coordination subscription. */
interface ClientSubscription {
  subscriptionId: string;
  response: LocalResponseBody;
}

/** A single authenticated connection's lifecycle flags and resources. */
interface ClientState {
  authenticated: boolean;
  closed: boolean;
  subscription?: ClientSubscription;
  subscriptionInFlight?: Promise<LocalResponseBody>;
  disposePromise?: Promise<void>;
}

/**
 * The loopback-only Local_API server. Construct with a token + handlers, then
 * {@link start} (which binds both enabled transports or throws a startup error
 * — Req 2.9) and {@link stop}.
 */
export class LocalApiServer {
  private readonly options: LocalApiServerOptions;
  private wss: WebSocketServer | undefined;
  private pipeServer: NetServer | undefined;
  private address: LocalApiAddress = {};
  private readonly clients = new Set<ClientState>();

  constructor(options: LocalApiServerOptions) {
    this.options = options;
  }

  /** The bound address(es); valid only after {@link start} resolves. */
  boundAddress(): LocalApiAddress {
    return this.address;
  }

  /**
   * Bind the enabled transports. Rejects (a startup error) if a transport cannot
   * bind, so the agent refuses clients rather than running half-open (Req 2.9).
   */
  async start(): Promise<LocalApiAddress> {
    const enableWs = this.options.enableWebSocket ?? true;
    const enablePipe =
      this.options.enableNamedPipe ?? process.platform === "win32";

    try {
      if (enableWs) {
        this.address.wsUrl = await this.startWebSocket();
      }
      if (enablePipe) {
        this.address.pipePath = await this.startNamedPipe();
      }
      return this.address;
    } catch (error) {
      // Do not leave a half-started Local_API reachable when a second transport
      // failed to bind. The caller receives the original startup error.
      await this.stop();
      throw error;
    }
  }

  private startWebSocket(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const wss = new WebSocketServer({
        host: "127.0.0.1",
        port: this.options.wsPort ?? 0,
        // Reject non-loopback origins at the handshake (Req 2.5).
        verifyClient: (info: { req: IncomingMessage }, done) => {
          const remote = info.req.socket.remoteAddress ?? undefined;
          done(isLoopbackAddress(remote));
        },
      });
      wss.on("error", (err) => reject(err));
      wss.on("listening", () => {
        const addr = wss.address();
        const port = typeof addr === "object" && addr !== null ? addr.port : 0;
        this.wss = wss;
        wss.on("connection", (socket) => this.handleWebSocket(socket));
        resolve(`ws://127.0.0.1:${port}`);
      });
    });
  }

  private startNamedPipe(): Promise<string> {
    const name = this.options.pipeName ?? `cfls-agent-${process.pid}`;
    const pipePath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\${name}`
        : `/tmp/${name}.sock`;
    return new Promise<string>((resolve, reject) => {
      const server = createNetServer((socket) => this.handlePipe(socket));
      server.on("error", (err) => reject(err));
      server.listen(pipePath, () => {
        this.pipeServer = server;
        resolve(pipePath);
      });
    });
  }

  // ---- WebSocket transport --------------------------------------------------

  private handleWebSocket(socket: WebSocket): void {
    const state = this.createClientState();
    socket.on("message", (data) => {
      void this.onFrame(
        String(data),
        state,
        (obj) => {
          if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify(obj));
          }
        },
        () => socket.close(),
      );
    });
    socket.once("close", () => {
      void this.disposeClient(state);
    });
    socket.once("error", () => {
      void this.disposeClient(state);
    });
  }

  // ---- Named-pipe transport (newline-delimited JSON) ------------------------

  private handlePipe(socket: Socket): void {
    const state = this.createClientState();
    let buffer = "";
    socket.setEncoding("utf8");
    const send = (obj: unknown): void => {
      if (!socket.destroyed && socket.writable) {
        socket.write(`${JSON.stringify(obj)}\n`);
      }
    };
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.trim().length > 0) {
          void this.onFrame(line, state, send, () => socket.end());
        }
        idx = buffer.indexOf("\n");
      }
    });
    socket.once("close", () => {
      void this.disposeClient(state);
    });
    socket.once("error", () => {
      void this.disposeClient(state);
    });
  }

  // ---- Shared frame handling ------------------------------------------------

  private async onFrame(
    raw: string,
    state: ClientState,
    send: (obj: unknown) => void,
    close: () => void,
  ): Promise<void> {
    let frame: {
      type?: string;
      id?: unknown;
      token?: unknown;
      method?: unknown;
      params?: unknown;
    };
    try {
      frame = JSON.parse(raw);
    } catch {
      send({ type: "error", message: "Malformed frame." });
      return;
    }

    // Authentication must precede every other frame (Req 2.5).
    if (frame.type === "auth") {
      if (
        typeof frame.token === "string" &&
        tokensMatch(frame.token, this.options.token)
      ) {
        state.authenticated = true;
        send({ type: "auth_ok" });
      } else {
        send({ type: "auth_error", message: "Invalid Local_Auth_Token." });
        close();
      }
      return;
    }

    if (!state.authenticated) {
      // Reject any request/subscription before authentication (Req 2.5, 25.6).
      send({ type: "auth_error", message: "Not authenticated." });
      close();
      return;
    }

    if (frame.type === "request" && typeof frame.method === "string") {
      try {
        const body = await this.options.handlers.request(
          frame.method,
          frame.params,
        );
        send({ type: "response", id: frame.id ?? null, body });
      } catch {
        send({
          type: "error",
          id: frame.id ?? null,
          message: "Local request failed.",
        });
      }
      return;
    }

    if (frame.type === "subscribe") {
      try {
        const body = await this.subscribeClient(
          state,
          frame.params,
          (update) => {
            if (!state.closed) {
              send({ type: "update", payload: update });
            }
          },
        );
        send({ type: "response", id: frame.id ?? null, body });
      } catch {
        send({
          type: "error",
          id: frame.id ?? null,
          message: "Local subscription failed.",
        });
      }
      return;
    }

    send({
      type: "error",
      id: frame.id ?? null,
      message: "Unknown frame type.",
    });
  }

  /** Register this connection's single update stream, idempotently. */
  private async subscribeClient(
    state: ClientState,
    params: unknown,
    push: (update: unknown) => void,
  ): Promise<LocalResponseBody> {
    if (state.subscription !== undefined) {
      return state.subscription.response;
    }
    if (state.subscriptionInFlight !== undefined) {
      return state.subscriptionInFlight;
    }

    const pending = this.options.handlers
      .subscribe(params, push)
      .then((response) => {
        const subscriptionId = extractSubscriptionId(response);
        if (subscriptionId !== undefined) {
          const subscription: ClientSubscription = { subscriptionId, response };
          if (state.closed) {
            void this.disposeSubscription(subscription);
          } else {
            state.subscription = subscription;
          }
        }
        return response;
      });
    state.subscriptionInFlight = pending;
    try {
      return await pending;
    } finally {
      if (state.subscriptionInFlight === pending) {
        delete state.subscriptionInFlight;
      }
    }
  }

  private createClientState(): ClientState {
    const state: ClientState = { authenticated: false, closed: false };
    this.clients.add(state);
    return state;
  }

  /** Dispose a connection once; safe to call from both error and close events. */
  private disposeClient(state: ClientState): Promise<void> {
    if (state.disposePromise !== undefined) {
      return state.disposePromise;
    }
    state.closed = true;
    this.clients.delete(state);
    const subscription = state.subscription;
    delete state.subscription;
    state.disposePromise = this.disposeSubscription(subscription);
    return state.disposePromise;
  }

  /** Best-effort listener cleanup: it must never make Local_API shutdown fail. */
  private async disposeSubscription(
    subscription: ClientSubscription | undefined,
  ): Promise<void> {
    if (
      subscription === undefined ||
      this.options.handlers.unsubscribe === undefined
    ) {
      return;
    }
    try {
      await this.options.handlers.unsubscribe(subscription.subscriptionId);
    } catch {
      // The agent may already be stopping. Closing the local connection still
      // must complete and the port's own dispose path is a final safety net.
    }
  }

  /** Stop both transports and release their handles. */
  async stop(): Promise<void> {
    await Promise.all(
      [...this.clients].map((state) => this.disposeClient(state)),
    );
    await new Promise<void>((resolve) => {
      if (this.wss === undefined) {
        resolve();
        return;
      }
      for (const client of this.wss.clients) {
        client.close();
      }
      this.wss.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      if (this.pipeServer === undefined) {
        resolve();
        return;
      }
      this.pipeServer.close(() => resolve());
    });
    this.wss = undefined;
    this.pipeServer = undefined;
    this.address = {};
  }
}

/** Extract the standard `AgentResult<SubscribeData>` subscription id safely. */
function extractSubscriptionId(body: LocalResponseBody): string | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const top = body as {
    ok?: unknown;
    subscriptionId?: unknown;
    data?: unknown;
  };
  if (top.ok !== undefined && top.ok !== true) {
    return undefined;
  }
  if (typeof top.subscriptionId === "string") {
    return top.subscriptionId;
  }
  if (typeof top.data !== "object" || top.data === null) {
    return undefined;
  }
  const data = top.data as { subscriptionId?: unknown };
  return typeof data.subscriptionId === "string"
    ? data.subscriptionId
    : undefined;
}
