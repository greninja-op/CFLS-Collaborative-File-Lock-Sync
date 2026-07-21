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
  clearInterval: (handle) =>
    clearInterval(handle as ReturnType<typeof setInterval>),
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
  private authWaiter: {
    promise: Promise<void>;
    resolve: () => void;
    reject: (e: Error) => void;
  } | null = null;
  private heartbeatHandle: unknown = null;
  private closeListeners = new Set<() => void>();
  /** A LocalApiClient owns one socket and is terminal after its first close. */
  private terminal = false;

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
    if (this.terminal) {
      queueMicrotask(() => {
        // Respect removal when a reconnect owner tears down between registration
        // and this deferred terminal notification.
        if (this.closeListeners.has(listener)) {
          listener();
        }
      });
    }
    return () => this.closeListeners.delete(listener);
  }

  /**
   * Authenticate the connection with the Local_Auth_Token (Req 2.5) and start
   * heartbeats on success (Req 26.6). Resolves once `auth_ok` is received.
   */
  authenticate(): Promise<void> {
    if (this.authenticated) {
      return Promise.resolve();
    }
    if (this.terminal) {
      return Promise.reject(new Error("Local_API connection closed."));
    }
    // A reconnect owner may race a manual refresh. Reuse its one auth exchange
    // rather than emitting duplicate credentials or leaving duplicate timers.
    if (this.authWaiter !== null) {
      return this.authWaiter.promise;
    }

    let resolvePromise!: () => void;
    let rejectPromise!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const timer = this.scheduler.setInterval(() => {
      // one-shot: clear immediately and fail if still unauthenticated.
      this.scheduler.clearInterval(timer);
      if (!this.authenticated && this.authWaiter === waiter) {
        this.authWaiter = null;
        rejectPromise(new Error("Timed out authenticating to the Local_API."));
      }
    }, this.requestTimeoutMs);
    const waiter = {
      promise,
      resolve: () => {
        this.scheduler.clearInterval(timer);
        resolvePromise();
      },
      reject: (error: Error) => {
        this.scheduler.clearInterval(timer);
        rejectPromise(error);
      },
    };
    this.authWaiter = waiter;
    try {
      this.transport.send({ type: "auth", token: this.token });
    } catch (error) {
      if (this.authWaiter === waiter) {
        this.authWaiter = null;
      }
      waiter.reject(asLocalApiError(error));
      this.onClose();
    }
    return promise;
  }

  /**
   * Invoke a Local_API method and resolve with the response body (an
   * `McpEnvelope`). Rejects on timeout or transport close.
   */
  request(method: string, params?: unknown): Promise<unknown> {
    if (this.terminal) {
      return Promise.reject(new Error("Local_API connection closed."));
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = this.scheduler.setInterval(() => {
        this.scheduler.clearInterval(timer);
        if (this.pending.delete(id)) {
          reject(new Error(`Local_API request '${method}' timed out.`));
        }
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.transport.send({ type: "request", id, method, params });
      } catch (error) {
        const pending = this.pending.get(id);
        if (pending !== undefined) {
          this.pending.delete(id);
          this.scheduler.clearInterval(pending.timer);
          pending.reject(asLocalApiError(error));
        }
        this.onClose();
      }
    });
  }

  /**
   * Register a Coordination_Update subscription for a session and stream pushed
   * updates to `onUpdate` (Req 25.1). Resolves with the subscription response.
   */
  subscribe(params: unknown, onUpdate: UpdateListener): Promise<unknown> {
    if (this.terminal) {
      return Promise.reject(new Error("Local_API connection closed."));
    }
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
      try {
        this.transport.send({ type: "subscribe", id, params });
      } catch (error) {
        this.updateListeners.delete(onUpdate);
        const pending = this.pending.get(id);
        if (pending !== undefined) {
          this.pending.delete(id);
          this.scheduler.clearInterval(pending.timer);
          pending.reject(asLocalApiError(error));
        }
        this.onClose();
      }
    });
  }

  /** Forward one Editor_Event to the agent (Req 3.2). Fire-and-forget. */
  sendEditorEvent(event: unknown): void {
    if (this.terminal) {
      return;
    }
    const id = this.nextId++;
    try {
      this.transport.send({
        type: "request",
        id,
        method: EDITOR_EVENT_METHOD,
        params: event,
      });
    } catch {
      // Editor activity is intentionally fire-and-forget. Do not cache/replay it
      // on a later Local_API instance; the fresh agent receives only new editor
      // signals after it reconnects.
      this.onClose();
    }
  }

  /** Send a single heartbeat to the agent (Req 26.6). Fire-and-forget. */
  sendHeartbeat(): void {
    if (this.terminal) {
      return;
    }
    const id = this.nextId++;
    try {
      this.transport.send({
        type: "request",
        id,
        method: HEARTBEAT_METHOD,
        params: { sentAt: new Date().toISOString() },
      });
    } catch {
      this.onClose();
    }
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
    // A socket implementation is normally expected to emit `close`, but make
    // cleanup deterministic even when it fails during its opening handshake.
    // This also rejects in-flight calls promptly during an explicit reconnect.
    this.onClose();
    this.transport.close();
  }

  // ---- Inbound frame handling -----------------------------------------------

  private onFrame(raw: string): void {
    if (this.terminal) {
      return;
    }
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
    if (this.terminal) {
      return;
    }
    this.terminal = true;
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
      try {
        listener();
      } catch {
        // A consumer's cleanup must not leave the rest of the Local_API
        // lifecycle (including pending-request rejection) half-finished.
      }
    }
  }
}

/** The small lifecycle surface needed by {@link LocalApiReconnectController}. */
export interface ReconnectableLocalApiClient {
  authenticate(): Promise<void>;
  onClosed(listener: () => void): () => void;
  close(): void | Promise<void>;
}

/** Configuration for bounded Local_API reconnection after an agent restart. */
export interface LocalApiReconnectControllerOptions<
  TClient extends ReconnectableLocalApiClient,
> {
  /** Create a brand-new client using freshly read discovery settings. */
  createClient(): TClient;
  /** Resolve session/subscription state after Local_API authentication. */
  initialize(client: TClient): Promise<void>;
  /** Publish one fully ready client to the extension runtime. */
  onConnected(client: TClient): void;
  /** Mark UI state unavailable when the current client becomes terminal. */
  onUnavailable(): void;
  /** Maximum fresh-client attempts per recovery run. Default: 8. */
  maxAttempts?: number;
  /** First exponential-backoff delay in ms. Default: 100. */
  initialDelayMs?: number;
  /** Maximum exponential-backoff delay in ms. Default: 1000. */
  maxDelayMs?: number;
  /** Injectable delay seam for deterministic tests. */
  delay?: (ms: number) => Promise<void>;
}

const DEFAULT_RECONNECT_ATTEMPTS = 8;
const DEFAULT_RECONNECT_INITIAL_DELAY_MS = 100;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 1_000;

/**
 * Owns one active Local_API client and replaces it after the per-user agent
 * service restarts. Every attempt calls `createClient()` anew, letting the
 * extension reread the atomically rotated discovery URL/token. It deliberately
 * never repeats a request from the dead client: callers receive its close error
 * and must explicitly issue a new operation after recovery.
 */
export class LocalApiReconnectController<
  TClient extends ReconnectableLocalApiClient,
> {
  private readonly maxAttempts: number;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly delay: (ms: number) => Promise<void>;
  private active: TClient | undefined;
  private removeActiveCloseListener: (() => void) | undefined;
  private recovery: Promise<TClient | undefined> | undefined;
  private disposed = false;

  constructor(
    private readonly options: LocalApiReconnectControllerOptions<TClient>,
  ) {
    this.maxAttempts = positiveInteger(
      options.maxAttempts,
      DEFAULT_RECONNECT_ATTEMPTS,
    );
    this.initialDelayMs = positiveInteger(
      options.initialDelayMs,
      DEFAULT_RECONNECT_INITIAL_DELAY_MS,
    );
    this.maxDelayMs = positiveInteger(
      options.maxDelayMs,
      DEFAULT_RECONNECT_MAX_DELAY_MS,
    );
    this.delay = options.delay ?? waitForLocalApiRetry;
  }

  /** The currently ready client, if any. */
  current(): TClient | undefined {
    return this.active;
  }

  /** Connect initially or recover a missing/closed client with bounded retries. */
  connect(): Promise<TClient | undefined> {
    if (this.disposed) {
      return Promise.resolve(undefined);
    }
    if (this.active !== undefined) {
      return Promise.resolve(this.active);
    }
    if (this.recovery !== undefined) {
      return this.recovery;
    }
    // `runRecovery` normally handles each candidate failure itself. Keep the
    // public lifecycle non-throwing even if an injected retry delay or a UI
    // callback unexpectedly fails, so a background reconnect never becomes an
    // unhandled extension-host rejection.
    const run = this.runRecovery().catch(() => undefined);
    const recovery: Promise<TClient | undefined> = run.then((result) => {
      if (this.recovery === recovery) {
        this.recovery = undefined;
      }
      return result;
    });
    // Clear the single-flight marker *before* callers observe the completed
    // result. That matters when a socket closes immediately after its initial
    // connect resolves: its close listener must start a new run, not reuse an
    // already-settled promise from the previous run.
    this.recovery = recovery;
    return recovery;
  }

  /** Force a fresh client, used by an explicit “reconnect local agent” command. */
  reconnect(): Promise<TClient | undefined> {
    if (this.disposed) {
      return Promise.resolve(undefined);
    }
    const previous = this.active;
    this.detachActive();
    if (previous !== undefined) {
      this.notifyUnavailable();
      void Promise.resolve(previous.close()).catch(() => undefined);
    }
    return this.connect();
  }

  /** Stop recovery and close the active client without scheduling another retry. */
  async close(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const previous = this.active;
    this.detachActive();
    if (previous !== undefined) {
      try {
        await previous.close();
      } catch {
        // Teardown must not prevent extension deactivation.
      }
    }
  }

  private async runRecovery(): Promise<TClient | undefined> {
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      if (this.disposed) {
        return undefined;
      }
      let candidate: TClient | undefined;
      try {
        // The factory is intentionally inside the retry loop: a restarting
        // service rotates its endpoint/token discovery record atomically.
        candidate = this.options.createClient();
        await candidate.authenticate();
        if (this.disposed) {
          await candidate.close();
          return undefined;
        }
        await this.options.initialize(candidate);
        if (this.disposed) {
          await candidate.close();
          return undefined;
        }
        this.activate(candidate);
        return candidate;
      } catch {
        if (candidate !== undefined) {
          try {
            await candidate.close();
          } catch {
            // A failed candidate is already unusable. Continue with new
            // discovery settings on the next bounded attempt.
          }
        }
      }

      if (attempt < this.maxAttempts - 1 && !this.disposed) {
        try {
          await this.delay(
            Math.min(this.initialDelayMs * 2 ** attempt, this.maxDelayMs),
          );
        } catch {
          // The next explicit reconnect can try again. Do not let a timer
          // implementation failure leak out of a fire-and-forget recovery.
          return undefined;
        }
      }
    }
    return undefined;
  }

  private activate(client: TClient): void {
    this.detachActive();
    this.active = client;
    this.removeActiveCloseListener = client.onClosed(() => {
      if (this.active !== client || this.disposed) {
        return;
      }
      this.detachActive();
      this.notifyUnavailable();
      void this.connect();
    });
    this.options.onConnected(client);
  }

  private detachActive(): void {
    this.removeActiveCloseListener?.();
    this.removeActiveCloseListener = undefined;
    this.active = undefined;
  }

  /** A presentation callback must not prevent transport recovery. */
  private notifyUnavailable(): void {
    try {
      this.options.onUnavailable();
    } catch {
      // The controller still owns a valid lifecycle even if an extension UI
      // renderer fails while it is switching to the offline presentation.
    }
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function waitForLocalApiRetry(delayMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
}

function asLocalApiError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
