/**
 * {@link LocalApiClient} — the Editor_Extension's client of the CoordinationAgent
 * Local_API (task 11.1; Req 3.1, 26.6; design §3.5).
 *
 * It connects **only** to the local agent, authenticates with the per-session
 * `Local_Auth_Token`, then exchanges `request`/`subscribe` frames (reusing the
 * agent's frame protocol). It correlates each `request` with its `response` by
 * id, fans pushed `update` frames out to subscription listeners, and sends
 * periodic heartbeats to the agent (Req 26.6).
 *
 * All socket I/O is behind the injected {@link FrameTransport}, and all timing is
 * behind the injected {@link Scheduler}, so the whole client is unit-testable
 * with no running agent and no real timers.
 */

import {
  EDITOR_EVENT_METHOD,
  HEARTBEAT_METHOD,
  parseInboundFrame,
  type LocalAuthToken,
} from "./frames";
import type { FrameTransport } from "./transport";

/** Injectable timer surface so heartbeats are testable without real timers. */
export interface Scheduler {
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** The default {@link Scheduler} backed by the host runtime's global timers. */
export const globalScheduler: Scheduler = {
  setInterval: (handler, ms) => setInterval(handler, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/** Options for a {@link LocalApiClient}. */
export interface LocalApiClientOptions {
  transport: FrameTransport;
  /** The per-session Local_Auth_Token presented at connect (Req 2.5). */
  token: LocalAuthToken;
  /** Heartbeat interval in ms (Req 26.6); <=0 disables. Default 10s. */
  heartbeatIntervalMs?: number;
  /** Injectable timer surface (default {@link globalScheduler}). */
  scheduler?: Scheduler;
  /** Request/auth correlation timeout in ms. Default 5s. */
  requestTimeoutMs?: number;
}

/** A pending request awaiting its correlated `response` frame. */
interface Pending {
  resolve: (body: unknown) => void;
  reject: (err: Error) => void;
  timer: unknown;
}

/** A registered Coordination_Update subscription listener. */
type UpdateListener = (update: unknown) => void;

/**
 * A loopback-only client of the CoordinationAgent Local_API. Never connects to
 * the CoordinationHost (Req 3.1).
 */
export class LocalApiClient {
  private readonly transport: FrameTransport;
  private readonly token: LocalAuthToken;
  private readonly heartbeatIntervalMs: number;
  private readonly scheduler: Scheduler;
  private readonly requestTimeoutMs: number;

  private nextId = 1;
  private authenticated = false;
  private readonly pending = new Map<number, Pending>();
  private readonly updateListeners = new Set<UpdateListener>();
  private authWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private heartbeatHandle: unknown = null;
  private closeListeners = new Set<() => void>();

  constructor(options: LocalApiClientOptions) {
    this.transport = options.transport;
    this.token = options.token;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
    this.scheduler = options.scheduler ?? globalScheduler;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5_000;

    this.transport.onMessage((raw) => this.onFrame(raw));
    this.transport.onClose(() => this.onClose());
  }

  /** Whether the Local_Auth_Token has been accepted by the agent. */
  isAuthenticated(): boolean {
    return this.authenticated;
  }

  /** Register a callback fired when the transport closes. */
  onClosed(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /**
   * Authenticate the connection with the Local_Auth_Token (Req 2.5) and start
   * heartbeats on success (Req 26.6). Resolves once `auth_ok` is received.
   */
  authenticate(): Promise<void> {
    this.transport.send({ type: "auth", token: this.token });
    return new Promise<void>((resolve, reject) => {
      const timer = this.scheduler.setInterval(() => {
        // one-shot: clear immediately and fail if still unauthenticated.
        this.scheduler.clearInterval(timer);
        if (!this.authenticated) {
          this.authWaiter = null;
          reject(new Error("Timed out authenticating to the Local_API."));
        }
      }, this.requestTimeoutMs);
      this.authWaiter = {
        resolve: () => {
          this.scheduler.clearInterval(timer);
          resolve();
        },
        reject: (e) => {
          this.scheduler.clearInterval(timer);
          reject(e);
        },
      };
    });
  }

  /**
   * Invoke a Local_API method and resolve with the response body (an
   * `McpEnvelope`). Rejects on timeout or transport close.
   */
  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = this.scheduler.setInterval(() => {
        this.scheduler.clearInterval(timer);
        if (this.pending.delete(id)) {
          reject(new Error(`Local_API request '${method}' timed out.`));
        }
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.transport.send({ type: "request", id, method, params });
    });
  }

  /**
   * Register a Coordination_Update subscription for a session and stream pushed
   * updates to `onUpdate` (Req 25.1). Resolves with the subscription response.
   */
  subscribe(params: unknown, onUpdate: UpdateListener): Promise<unknown> {
    this.updateListeners.add(onUpdate);
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = this.scheduler.setInterval(() => {
        this.scheduler.clearInterval(timer);
        if (this.pending.delete(id)) {
          reject(new Error("Local_API subscribe timed out."));
        }
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.transport.send({ type: "subscribe", id, params });
    });
  }

  /** Forward one Editor_Event to the agent (Req 3.2). Fire-and-forget. */
  sendEditorEvent(event: unknown): void {
    const id = this.nextId++;
    this.transport.send({ type: "request", id, method: EDITOR_EVENT_METHOD, params: event });
  }

  /** Send a single heartbeat to the agent (Req 26.6). Fire-and-forget. */
  sendHeartbeat(): void {
    const id = this.nextId++;
    this.transport.send({
      type: "request",
      id,
      method: HEARTBEAT_METHOD,
      params: { sentAt: new Date().toISOString() },
    });
  }

  /** Begin the periodic heartbeat loop (Req 26.6). Idempotent. */
  startHeartbeats(): void {
    if (this.heartbeatIntervalMs <= 0 || this.heartbeatHandle !== null) {
      return;
    }
    this.heartbeatHandle = this.scheduler.setInterval(() => {
      if (this.authenticated) {
        this.sendHeartbeat();
      }
    }, this.heartbeatIntervalMs);
  }

  /** Stop the periodic heartbeat loop. */
  stopHeartbeats(): void {
    if (this.heartbeatHandle !== null) {
      this.scheduler.clearInterval(this.heartbeatHandle);
      this.heartbeatHandle = null;
    }
  }

  /** Close the connection and release resources. */
  close(): void {
    this.stopHeartbeats();
    this.transport.close();
  }

  // ---- Inbound frame handling -----------------------------------------------

  private onFrame(raw: string): void {
    const frame = parseInboundFrame(raw);
    if (frame === null) {
      return;
    }
    switch (frame.type) {
      case "auth_ok":
        this.authenticated = true;
        this.startHeartbeats();
        this.authWaiter?.resolve();
        this.authWaiter = null;
        return;
      case "auth_error":
        this.authenticated = false;
        this.authWaiter?.reject(
          new Error(frame.message ?? "Local_Auth_Token rejected by the agent."),
        );
        this.authWaiter = null;
        return;
      case "response": {
        if (typeof frame.id !== "number") {
          return;
        }
        const pending = this.pending.get(frame.id);
        if (pending !== undefined) {
          this.pending.delete(frame.id);
          this.scheduler.clearInterval(pending.timer);
          pending.resolve(frame.body);
        }
        return;
      }
      case "update":
        for (const listener of this.updateListeners) {
          listener(frame.payload);
        }
        return;
      case "error":
        // A frame-level error not correlated to a request id is surfaced to any
        // matching pending request; unmatched errors are ignored (best effort).
        if (typeof frame.id === "number") {
          const pending = this.pending.get(frame.id);
          if (pending !== undefined) {
            this.pending.delete(frame.id);
            this.scheduler.clearInterval(pending.timer);
            pending.reject(new Error(frame.message ?? "Local_API error."));
          }
        }
        return;
    }
  }

  private onClose(): void {
    this.authenticated = false;
    this.stopHeartbeats();
    for (const [, pending] of this.pending) {
      this.scheduler.clearInterval(pending.timer);
      pending.reject(new Error("Local_API connection closed."));
    }
    this.pending.clear();
    if (this.authWaiter !== null) {
      this.authWaiter.reject(new Error("Local_API connection closed."));
      this.authWaiter = null;
    }
    for (const listener of this.closeListeners) {
      listener();
    }
  }
}
