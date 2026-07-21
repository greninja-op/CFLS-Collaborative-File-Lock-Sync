/**
 * External stdio MCP bridge for a running CFLS CoordinationAgent.
 *
 * The agent owns the one authenticated connection to the CoordinationHost and
 * already exposes its shared AgentPort through an authenticated loopback
 * WebSocket. This module adapts that Local_API to the existing
 * `@cfls/mcp-server` tool surface, then serves it over MCP stdio for desktop AI
 * clients. It deliberately never talks to the CoordinationHost directly.
 */

import { createMcpServer } from "@cfls/mcp-server";
import type {
  AcquireLockData,
  AcquireLockRequest,
  AgentPort,
  AgentResult,
  ConnectionSnapshot,
  ConnectionStatusData,
  DeclareIntentData,
  DeclareIntentRequest,
  GetDependenciesData,
  GetDependenciesRequest,
  GetDependencyImpactData,
  GetDependencyImpactRequest,
  GetDependentsData,
  GetDependentsRequest,
  GetRiskMapData,
  GetRiskMapRequest,
  GetTeamStatusData,
  GetTeamStatusRequest,
  McpEnvelope,
  ProjectSessionStatusData,
  ReleaseLockData,
  ReleaseLockRequest,
  StalenessSnapshot,
  SubscribeData,
  SubscribeRequest,
  UpdateIntentData,
  UpdateIntentRequest,
  WithdrawIntentData,
  WithdrawIntentRequest,
} from "@cfls/mcp-server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  isErrorCode,
  type CoordinationUpdate,
  type SessionId,
} from "@cfls/protocol";
import { WebSocket, type RawData } from "ws";

import { readLocalApiConfig, type LocalApiConfigFile } from "./config-files";
import { localApiConfigPath } from "./paths";

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
// A Local_API restart normally takes only a moment, but the bridge must not
// keep retrying forever after the agent has been intentionally stopped. These
// limits also ensure a broken discovery record cannot create an unbounded
// background loop in a long-lived MCP process.
const BACKGROUND_RECONNECT_MAX_ATTEMPTS = 8;
const BACKGROUND_RECONNECT_INITIAL_DELAY_MS = 100;
const BACKGROUND_RECONNECT_MAX_DELAY_MS = 1_000;

const UNAVAILABLE_CONNECTION: ConnectionSnapshot = {
  status: "offline",
  hostUrl: "",
  lastSyncAt: null,
};

const UNAVAILABLE_STALENESS: StalenessSnapshot = {
  stale: true,
  secondsSinceSync: null,
};

/** A descriptive, token-safe error raised by the local bridge transport. */
export class LocalApiBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalApiBridgeError";
  }
}

interface PendingResponse {
  resolve: (body: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

/** A cancellable delay between background Local_API recovery attempts. */
interface BackgroundRetryWait {
  timer: NodeJS.Timeout;
  finish: () => void;
}

export interface LocalApiClientOptions {
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

/**
 * Options for a long-lived MCP bridge. `discoveryPath` is deliberately kept
 * separate from the initial record: an agent restart rotates both the
 * loopback URL and Local_Auth_Token, so a reconnect must read the current
 * owner-only discovery record instead of reusing stale credentials.
 */
export interface McpBridgeOptions extends LocalApiClientOptions {
  discoveryPath?: string;
}

type CoordinationUpdateHandler = (update: CoordinationUpdate) => void;

/** One deduplicated Local_API subscription and its MCP-facing listeners. */
interface BridgeSubscription {
  callbacks: Set<CoordinationUpdateHandler>;
  request: SubscribeRequest;
  /** The client on which the current registration attempt is running/active. */
  client: LocalApiWebSocketClient | undefined;
  result: Promise<AgentResult<SubscribeData>> | undefined;
  /** Set only after Local_API accepted this subscription on the current client. */
  registeredClient: LocalApiWebSocketClient | undefined;
}

/** A connected authenticated client for the agent's Local_API WebSocket. */
export class LocalApiWebSocketClient {
  private readonly socket: WebSocket;
  private readonly requestTimeoutMs: number;
  private readonly opened: Promise<void>;
  private readonly pending = new Map<number, PendingResponse>();
  private readonly updateHandlers = new Set<
    (update: CoordinationUpdate) => void
  >();
  private readonly unavailableHandlers = new Set<() => void>();
  private authentication: Deferred<void> | undefined;
  private authenticated = false;
  private terminalError: Error | undefined;
  private closed = false;
  private nextId = 1;

  private constructor(socket: WebSocket, requestTimeoutMs: number) {
    this.socket = socket;
    this.requestTimeoutMs = requestTimeoutMs;
    this.opened = new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        cleanup();
        resolve();
      };
      const onFailure = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onClose = (): void => {
        cleanup();
        reject(
          new LocalApiBridgeError("The CFLS Local_API closed before opening."),
        );
      };
      const cleanup = (): void => {
        socket.off("open", onOpen);
        socket.off("error", onFailure);
        socket.off("close", onClose);
      };

      socket.once("open", onOpen);
      socket.once("error", onFailure);
      socket.once("close", onClose);
    });

    socket.on("message", (data: RawData) => this.onMessage(data));
    socket.on("error", (error: Error) => this.fail(error));
    socket.on("close", (code: number, reason: Buffer) => {
      const suffix = reason.length > 0 ? ` (${reason.toString("utf8")})` : "";
      this.closed = true;
      this.fail(
        new LocalApiBridgeError(
          `The CFLS Local_API connection closed (code ${code})${suffix}.`,
        ),
      );
    });
  }

  /** Connect, verify the peer is loopback, and authenticate with the discovery token. */
  static async connect(
    config: LocalApiConfigFile,
    options: LocalApiClientOptions = {},
  ): Promise<LocalApiWebSocketClient> {
    const url = validateLocalApiUrl(config.url);
    if (config.token.length === 0) {
      throw new LocalApiBridgeError(
        'The CFLS Local_API discovery record has an empty authentication token. Restart "cfls agent".',
      );
    }

    const connectTimeoutMs =
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    let socket: WebSocket;
    try {
      socket = new WebSocket(url.toString());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new LocalApiBridgeError(
        `Could not open the CFLS Local_API WebSocket at ${url.toString()}: ${message}`,
      );
    }
    const client = new LocalApiWebSocketClient(socket, requestTimeoutMs);

    try {
      await withTimeout(
        client.opened,
        connectTimeoutMs,
        "connecting to the CFLS Local_API",
      );
      await withTimeout(
        client.authenticate(config.token),
        connectTimeoutMs,
        "authenticating with the CFLS Local_API",
      );
      return client;
    } catch (error) {
      await client.close();
      const message = error instanceof Error ? error.message : String(error);
      throw new LocalApiBridgeError(
        `Could not connect to the running CFLS agent at ${url.toString()}: ${message}`,
      );
    }
  }

  /** Send a normal Local_API request and return its response body. */
  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.sendRequest("request", method, params);
  }

  /** Send the Local_API's dedicated subscription frame. */
  subscribe(params: Record<string, unknown>): Promise<unknown> {
    return this.sendRequest("subscribe", undefined, params);
  }

  /** Register a listener for Coordination_Updates received after a subscription. */
  addUpdateHandler(handler: (update: CoordinationUpdate) => void): void {
    this.updateHandlers.add(handler);
  }

  /** Register a listener that runs once this connection can no longer be used. */
  addUnavailableHandler(handler: () => void): () => void {
    this.unavailableHandlers.add(handler);
    return () => this.unavailableHandlers.delete(handler);
  }

  /** Whether this authenticated WebSocket can carry another Local_API frame. */
  isReady(): boolean {
    return (
      this.terminalError === undefined &&
      !this.closed &&
      this.authenticated &&
      this.socket.readyState === WebSocket.OPEN
    );
  }

  /** Close the loopback connection and reject any requests still in flight. */
  async close(): Promise<void> {
    if (this.closed || this.socket.readyState === WebSocket.CLOSED) {
      this.closed = true;
      this.rejectPending(
        new LocalApiBridgeError("The CFLS Local_API connection is closed."),
      );
      return;
    }

    this.closed = true;
    this.rejectPending(
      new LocalApiBridgeError("The CFLS Local_API connection was closed."),
    );
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(() => {
        this.socket.terminate();
        finish();
      }, 1_000);
      this.socket.once("close", finish);
      this.socket.close();
    });
  }

  private async authenticate(token: string): Promise<void> {
    if (this.authenticated) {
      return;
    }
    if (this.authentication !== undefined) {
      return this.authentication.promise;
    }

    const authentication = deferred<void>();
    this.authentication = authentication;
    try {
      this.sendRaw({ type: "auth", token });
    } catch (error) {
      const normalized = asError(error);
      authentication.reject(normalized);
      throw normalized;
    }
    return authentication.promise;
  }

  private sendRequest(
    type: "request" | "subscribe",
    method: string | undefined,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    this.ensureReady();
    const id = this.nextId;
    this.nextId += 1;

    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new LocalApiBridgeError(
            `The CFLS Local_API did not respond to request ${id} within ${this.requestTimeoutMs}ms.`,
          ),
        );
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timeout });

      const frame: Record<string, unknown> = { type, id, params };
      if (method !== undefined) {
        frame.method = method;
      }
      try {
        this.sendRaw(frame, (error) => {
          if (error != null) {
            this.rejectOne(id, asError(error));
          }
        });
      } catch (error) {
        this.rejectOne(id, asError(error));
      }
    });
  }

  private sendRaw(
    frame: Record<string, unknown>,
    onSent?: (error: Error | undefined) => void,
  ): void {
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw new LocalApiBridgeError(
        "The CFLS Local_API WebSocket is not open.",
      );
    }
    this.socket.send(JSON.stringify(frame), onSent);
  }

  private ensureReady(): void {
    if (this.terminalError !== undefined) {
      throw this.terminalError;
    }
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      throw new LocalApiBridgeError(
        "The CFLS Local_API connection is not available.",
      );
    }
    if (!this.authenticated) {
      throw new LocalApiBridgeError(
        "The CFLS Local_API connection is not authenticated.",
      );
    }
  }

  private onMessage(data: RawData): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawDataToString(data));
    } catch {
      this.fail(
        new LocalApiBridgeError("The CFLS Local_API sent malformed JSON."),
      );
      return;
    }
    const frame = asRecord(parsed);
    if (frame === undefined || typeof frame["type"] !== "string") {
      this.fail(
        new LocalApiBridgeError(
          "The CFLS Local_API sent an invalid response frame.",
        ),
      );
      return;
    }

    switch (frame["type"]) {
      case "auth_ok":
        if (this.authentication === undefined) {
          this.fail(
            new LocalApiBridgeError(
              "The CFLS Local_API sent an unexpected authentication response.",
            ),
          );
          return;
        }
        this.authenticated = true;
        this.authentication.resolve();
        return;
      case "auth_error": {
        const error = new LocalApiBridgeError(
          `CFLS Local_API authentication failed: ${frameMessage(frame)}`,
        );
        if (this.authentication !== undefined) {
          this.authentication.reject(error);
        }
        this.fail(error);
        return;
      }
      case "response": {
        const id = frame["id"];
        if (typeof id !== "number") {
          this.fail(
            new LocalApiBridgeError(
              "The CFLS Local_API response did not include a numeric request id.",
            ),
          );
          return;
        }
        const pending = this.pending.get(id);
        if (pending === undefined) {
          return;
        }
        this.pending.delete(id);
        clearTimeout(pending.timeout);
        pending.resolve(frame["body"]);
        return;
      }
      case "update": {
        const update = frame["payload"] as CoordinationUpdate;
        for (const handler of this.updateHandlers) {
          try {
            handler(update);
          } catch {
            // A consumer callback must not disrupt the shared bridge connection.
          }
        }
        return;
      }
      case "error": {
        const error = new LocalApiBridgeError(
          `The CFLS Local_API rejected a frame: ${frameMessage(frame)}`,
        );
        const id = frame["id"];
        if (typeof id === "number") {
          this.rejectOne(id, error);
        } else {
          this.fail(error);
        }
        return;
      }
      default:
        this.fail(
          new LocalApiBridgeError(
            `The CFLS Local_API sent an unsupported frame type '${frame["type"]}'.`,
          ),
        );
    }
  }

  private rejectOne(id: number, error: Error): void {
    const pending = this.pending.get(id);
    if (pending === undefined) {
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timeout);
    pending.reject(error);
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
  }

  private fail(error: Error): void {
    if (this.terminalError !== undefined) {
      return;
    }
    this.terminalError = error;
    if (this.authentication !== undefined && !this.authenticated) {
      this.authentication.reject(error);
    }
    this.rejectPending(error);
    for (const handler of this.unavailableHandlers) {
      try {
        handler();
      } catch {
        // A status observer must not affect the Local_API connection cleanup.
      }
    }
  }
}

/**
 * An AgentPort implementation that forwards each MCP operation to the running
 * local agent. The existing MCP server remains responsible for validation and
 * tool descriptions; this adapter only carries calls over the Local_API.
 */
export class LocalApiAgentPort implements AgentPort {
  private connection: ConnectionSnapshot = { ...UNAVAILABLE_CONNECTION };
  private staleness: StalenessSnapshot = { ...UNAVAILABLE_STALENESS };
  private readonly subscriptions = new Map<string, BridgeSubscription>();
  private reconnecting: Promise<LocalApiWebSocketClient> | undefined;
  private backgroundRecovery: Promise<void> | undefined;
  private backgroundRetryWait: BackgroundRetryWait | undefined;
  /**
   * The outcome of the most recent subscription restoration on each client.
   * It prevents the recovery loop from issuing a second registration
   * immediately after reconnect() already made one. A failed outcome is
   * cleared after the loop applies its backoff, allowing the next attempt.
   */
  private readonly subscriptionRestoreOutcomes = new WeakMap<
    LocalApiWebSocketClient,
    boolean
  >();
  private closed = false;

  constructor(
    private client: LocalApiWebSocketClient,
    private readonly readCurrentConfig: () => LocalApiConfigFile | null,
    private readonly clientOptions: LocalApiClientOptions,
  ) {
    this.observeClient(client);
  }

  /** Stop reconnect attempts and close the currently active Local_API client. */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.cancelBackgroundRetryWait();
    this.connection = { ...UNAVAILABLE_CONNECTION };
    this.staleness = { ...UNAVAILABLE_STALENESS };
    await this.client.close();
  }

  private observeClient(client: LocalApiWebSocketClient): void {
    // One Local_API listener fans into deduplicated session subscriptions. This
    // prevents every repeated MCP subscribe call from registering another
    // WebSocket callback and therefore repeating every MCP notification.
    client.addUpdateHandler((update) => {
      if (this.client === client) {
        this.dispatchUpdate(update);
      }
    });
    client.addUnavailableHandler(() => {
      // Do not let a late close from a replaced socket make the newly connected
      // agent look unavailable.
      if (this.client !== client || this.closed) {
        return;
      }
      this.connection = { ...UNAVAILABLE_CONNECTION };
      this.staleness = { ...UNAVAILABLE_STALENESS };
      this.startBackgroundRecovery();
    });
  }

  getConnection(): ConnectionSnapshot {
    return { ...this.connection };
  }

  getStaleness(): StalenessSnapshot {
    return { ...this.staleness };
  }

  getRiskMap(req: GetRiskMapRequest): Promise<AgentResult<GetRiskMapData>> {
    return this.request("get_risk_map", { session: req.session });
  }

  getTeamStatus(
    req: GetTeamStatusRequest,
  ): Promise<AgentResult<GetTeamStatusData>> {
    return this.request("get_team_status", { session: req.session });
  }

  getDependencyImpact(
    req: GetDependencyImpactRequest,
  ): Promise<AgentResult<GetDependencyImpactData>> {
    return this.request("get_dependency_impact", { paths: req.paths });
  }

  getDependencies(
    req: GetDependenciesRequest,
  ): Promise<AgentResult<GetDependenciesData>> {
    return this.request("get_dependencies", { path: req.path });
  }

  getDependents(
    req: GetDependentsRequest,
  ): Promise<AgentResult<GetDependentsData>> {
    return this.request("get_dependents", { path: req.path });
  }

  declareIntent(
    req: DeclareIntentRequest,
  ): Promise<AgentResult<DeclareIntentData>> {
    const params: Record<string, unknown> = {
      session: req.session,
      modifyPaths: req.modifyPaths,
      createPaths: req.createPaths,
      description: req.description,
    };
    if (req.scopeKind !== undefined) {
      params["scopeKind"] = req.scopeKind;
    }
    return this.request("declare_intent", params);
  }

  updateIntent(
    req: UpdateIntentRequest,
  ): Promise<AgentResult<UpdateIntentData>> {
    return this.request("update_intent", {
      intentId: req.intentId,
      modifyPaths: req.modifyPaths,
      createPaths: req.createPaths,
      description: req.description,
    });
  }

  withdrawIntent(
    req: WithdrawIntentRequest,
  ): Promise<AgentResult<WithdrawIntentData>> {
    return this.request("withdraw_intent", { intentId: req.intentId });
  }

  acquireLock(req: AcquireLockRequest): Promise<AgentResult<AcquireLockData>> {
    return this.request("acquire_lock", {
      session: req.session,
      scope: req.scope,
      scopeKind: req.scopeKind,
    });
  }

  releaseLock(req: ReleaseLockRequest): Promise<AgentResult<ReleaseLockData>> {
    const params: Record<string, unknown> = {};
    if (req.lockId !== undefined) {
      params["lockId"] = req.lockId;
    }
    if (req.scope !== undefined) {
      params["scope"] = req.scope;
    }
    return this.request("release_lock", params);
  }

  getConnectionStatus(): Promise<AgentResult<ConnectionStatusData>> {
    return this.request("get_connection_status", {});
  }

  getProjectSessionStatus(): Promise<AgentResult<ProjectSessionStatusData>> {
    return this.request("get_project_session_status", {});
  }

  async subscribeToCoordinationUpdates(
    req: SubscribeRequest,
    onUpdate?: CoordinationUpdateHandler,
  ): Promise<AgentResult<SubscribeData>> {
    const key = subscriptionKey(req.session);
    let subscription = this.subscriptions.get(key);
    if (subscription === undefined) {
      subscription = {
        callbacks: new Set(),
        request: req,
        client: undefined,
        result: undefined,
        registeredClient: undefined,
      };
      this.subscriptions.set(key, subscription);
    }
    if (onUpdate !== undefined) {
      subscription.callbacks.add(onUpdate);
    }
    const client = await this.connectedClient();
    return this.openSubscription(client, subscription);
  }

  private openSubscription(
    client: LocalApiWebSocketClient,
    subscription: BridgeSubscription,
  ): Promise<AgentResult<SubscribeData>> {
    if (subscription.client === client && subscription.result !== undefined) {
      return subscription.result;
    }

    // The Local_API's subscription response is an AgentResult rather than an
    // envelope. Sample a normal status request first so the existing MCP tool
    // can still attach live connection/staleness metadata to its response.
    const result = (async (): Promise<AgentResult<SubscribeData>> => {
      await this.requestWithClient<ConnectionStatusData>(
        client,
        "get_connection_status",
        {},
      );
      const response = await client.subscribe({
        session: subscription.request.session,
      });
      return parseAgentResult<SubscribeData>(
        response,
        "subscribe_to_coordination_updates",
      );
    })();
    subscription.client = client;
    subscription.result = result;
    subscription.registeredClient = undefined;
    void result.then(
      (resolved) => {
        if (subscription.client !== client || subscription.result !== result) {
          return;
        }
        if (resolved.ok) {
          subscription.registeredClient = client;
        } else {
          // A rejected subscription can be retried on the next tool call or
          // the next Local_API reconnect. Keep its callbacks: the MCP server
          // has one stable callback per session and needs it after an agent
          // restart.
          subscription.client = undefined;
          subscription.result = undefined;
          subscription.registeredClient = undefined;
        }
      },
      () => {
        if (subscription.client === client && subscription.result === result) {
          subscription.client = undefined;
          subscription.result = undefined;
          subscription.registeredClient = undefined;
        }
      },
    );
    return result;
  }

  private dispatchUpdate(update: CoordinationUpdate): void {
    for (const subscription of this.subscriptions.values()) {
      for (const callback of subscription.callbacks) {
        try {
          callback(update);
        } catch {
          // A downstream MCP client must not disrupt the bridge's one shared
          // Local_API connection or other subscribers.
        }
      }
    }
  }

  private async request<T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<AgentResult<T>> {
    const client = await this.connectedClient();
    return this.requestWithClient<T>(client, method, params);
  }

  private async requestWithClient<T>(
    client: LocalApiWebSocketClient,
    method: string,
    params: Record<string, unknown>,
  ): Promise<AgentResult<T>> {
    const response = await client.request(method, params);
    const envelope = parseMcpEnvelope<T>(response, method);
    if (this.client === client) {
      this.connection = envelope.connection;
      this.staleness = envelope.staleness;
    }
    return toAgentResult(envelope);
  }

  /**
   * Return a usable Local_API connection. A failed request is never replayed:
   * mutating MCP calls are not safely idempotent. Instead, the next call first
   * establishes a fresh authenticated connection using the current discovery
   * record, then re-registers every logical subscription on that connection.
   */
  private async connectedClient(): Promise<LocalApiWebSocketClient> {
    if (this.closed) {
      throw new LocalApiBridgeError("The CFLS MCP bridge is closed.");
    }
    if (this.client.isReady()) {
      return this.client;
    }
    if (this.reconnecting !== undefined) {
      return this.reconnecting;
    }

    const reconnecting = this.reconnect();
    this.reconnecting = reconnecting;
    try {
      return await reconnecting;
    } finally {
      if (this.reconnecting === reconnecting) {
        this.reconnecting = undefined;
      }
    }
  }

  private async reconnect(): Promise<LocalApiWebSocketClient> {
    let config: LocalApiConfigFile | null;
    try {
      config = this.readCurrentConfig();
    } catch {
      throw new LocalApiBridgeError(
        "Could not read the current CFLS Local_API discovery record. Restart the agent and try again.",
      );
    }
    if (config === null) {
      throw new LocalApiBridgeError(
        'No valid CFLS Local_API discovery record is available. Restart "cfls agent" in this workspace and try again.',
      );
    }

    const next = await LocalApiWebSocketClient.connect(
      config,
      this.clientOptions,
    );
    if (this.closed) {
      await next.close();
      throw new LocalApiBridgeError("The CFLS MCP bridge is closed.");
    }

    const previous = this.client;
    this.client = next;
    this.observeClient(next);
    // The next normal request, and the status requests below, refresh these
    // snapshots. Until then do not expose the previous agent's state.
    this.connection = { ...UNAVAILABLE_CONNECTION };
    this.staleness = { ...UNAVAILABLE_STALENESS };
    if (previous !== next) {
      void previous.close().catch(() => undefined);
    }

    await this.restoreSubscriptions(next);
    return next;
  }

  /**
   * Restore every logical subscription after restart. The callbacks remain in
   * memory even when a prior Local_API process has gone away, so a successful
   * registration here makes the MCP stream live again without another tool
   * call from the MCP client.
   */
  private async restoreSubscriptions(
    client: LocalApiWebSocketClient,
  ): Promise<boolean> {
    const restored = await Promise.all(
      [...this.subscriptions.values()].map(async (subscription) => {
        try {
          const result = await this.openSubscription(client, subscription);
          return result.ok && subscription.registeredClient === client;
        } catch {
          // Keep the logical subscription and callbacks. If this connection
          // also fails, the bounded background recovery loop retries with the
          // current discovery record. A later subscribe call can also retry
          // without losing the stable MCP listener.
          return false;
        }
      }),
    );
    const allRestored = client.isReady() && restored.every(Boolean);
    if (this.client === client) {
      this.subscriptionRestoreOutcomes.set(client, allRestored);
    }
    return allRestored;
  }

  /**
   * The Local_API socket has failed while at least one MCP client is listening.
   * Start exactly one bounded recovery loop. It only reconnects and restores
   * subscriptions; it never repeats a failed request or mutation.
   */
  private startBackgroundRecovery(): void {
    if (
      this.closed ||
      this.subscriptions.size === 0 ||
      this.backgroundRecovery !== undefined
    ) {
      return;
    }

    const recovery = this.recoverSubscriptionsInBackground();
    this.backgroundRecovery = recovery;
    void recovery.then(
      () => {
        if (this.backgroundRecovery === recovery) {
          this.backgroundRecovery = undefined;
        }
      },
      () => {
        // The loop handles each expected reconnect failure internally. Keep a
        // final guard so an unexpected error cannot leave it marked as running.
        if (this.backgroundRecovery === recovery) {
          this.backgroundRecovery = undefined;
        }
      },
    );
  }

  private async recoverSubscriptionsInBackground(): Promise<void> {
    for (
      let attempt = 0;
      attempt < BACKGROUND_RECONNECT_MAX_ATTEMPTS;
      attempt += 1
    ) {
      if (this.closed) {
        return;
      }

      try {
        const client = await this.connectedClient();
        // reconnect() already tries a restoration on a newly connected client.
        // Do not send a duplicate subscribe frame before applying backoff when
        // that registration was rejected or interrupted.
        if (
          !this.subscriptionsRegisteredOn(client) &&
          this.subscriptionRestoreOutcomes.get(client) === undefined
        ) {
          await this.restoreSubscriptions(client);
        }
        if (client.isReady() && this.subscriptionsRegisteredOn(client)) {
          return;
        }
        // A failed outcome is only useful for this attempt. Removing it permits
        // the next bounded retry to re-register on the same healthy socket.
        this.subscriptionRestoreOutcomes.delete(client);
      } catch {
        // Discovery records are atomically rotated during agent startup. A
        // transient missing/stale record is expected until the next backoff.
      }

      if (this.closed || attempt === BACKGROUND_RECONNECT_MAX_ATTEMPTS - 1) {
        return;
      }
      await this.waitForBackgroundRetry(
        Math.min(
          BACKGROUND_RECONNECT_INITIAL_DELAY_MS * 2 ** attempt,
          BACKGROUND_RECONNECT_MAX_DELAY_MS,
        ),
      );
    }
  }

  private subscriptionsRegisteredOn(client: LocalApiWebSocketClient): boolean {
    return [...this.subscriptions.values()].every(
      (subscription) => subscription.registeredClient === client,
    );
  }

  private waitForBackgroundRetry(delayMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const finish = (): void => {
        const current = this.backgroundRetryWait;
        if (current?.finish === finish) {
          this.backgroundRetryWait = undefined;
          clearTimeout(current.timer);
        }
        resolve();
      };
      const wait: BackgroundRetryWait = {
        timer: setTimeout(finish, delayMs),
        finish,
      };
      this.backgroundRetryWait = wait;
    });
  }

  private cancelBackgroundRetryWait(): void {
    const wait = this.backgroundRetryWait;
    if (wait === undefined) {
      return;
    }
    this.backgroundRetryWait = undefined;
    clearTimeout(wait.timer);
    wait.finish();
  }
}

/** The live pieces created for one external MCP bridge process. */
export interface McpBridge {
  server: ReturnType<typeof createMcpServer>;
  port: LocalApiAgentPort;
  close: () => Promise<void>;
}

/** Connect to an already-running local agent and create its MCP tool server. */
export async function createMcpBridge(
  config: LocalApiConfigFile,
  options: McpBridgeOptions = {},
): Promise<McpBridge> {
  const client = await LocalApiWebSocketClient.connect(config, options);
  const readCurrentConfig =
    options.discoveryPath === undefined
      ? (): LocalApiConfigFile => config
      : (): LocalApiConfigFile | null =>
          readLocalApiConfig(options.discoveryPath!);
  const port = new LocalApiAgentPort(client, readCurrentConfig, options);
  return {
    server: createMcpServer(port),
    port,
    close: () => port.close(),
  };
}

/**
 * Start the external stdio server for a workspace. This function intentionally
 * emits no stdout output: stdout becomes the JSON-RPC transport immediately.
 */
export async function startMcpBridge(workspace: string): Promise<void> {
  const discoveryPath = localApiConfigPath(workspace);
  const config = readLocalApiConfig(discoveryPath);
  if (config === null) {
    throw new LocalApiBridgeError(
      `No valid CFLS Local_API discovery file was found at ${discoveryPath}. Start the agent with "cfls agent" in this workspace first.`,
    );
  }

  const bridge = await createMcpBridge(config, { discoveryPath });
  const transport = new StdioServerTransport();
  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    process.stdin.off("end", onStdinEnd);
    void bridge.close();
  };
  const onStdinEnd = (): void => {
    void bridge.server.close();
  };

  // Stderr is safe for diagnostics; stdout is reserved exclusively for MCP.
  transport.onerror = (error) => {
    console.error(`CFLS MCP stdio transport error: ${error.message}`);
  };
  transport.onclose = cleanup;
  bridge.server.server.onerror = (error: Error) => {
    console.error(`CFLS MCP bridge error: ${error.message}`);
  };
  process.stdin.once("end", onStdinEnd);

  try {
    await bridge.server.connect(transport);
  } catch (error) {
    process.stdin.off("end", onStdinEnd);
    await bridge.close();
    throw error;
  }
}

function validateLocalApiUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new LocalApiBridgeError("The CFLS Local_API URL is invalid.");
  }
  if (url.protocol !== "ws:") {
    throw new LocalApiBridgeError(
      "The CFLS Local_API URL must use the ws: loopback transport.",
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new LocalApiBridgeError(
      "The CFLS Local_API URL must not include credentials.",
    );
  }
  if (!isNumericLoopbackHost(url.hostname)) {
    throw new LocalApiBridgeError(
      "The CFLS Local_API URL must point to a numeric loopback address.",
    );
  }
  return url;
}

function isNumericLoopbackHost(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "[::ffff:127.0.0.1]" ||
    hostname === "[::ffff:7f00:1]"
  );
}

/** A lossless, stable key for one Local_API subscription per session. */
function subscriptionKey(session: SessionId): string {
  return JSON.stringify([
    session.repoId,
    session.teamId,
    session.branch,
    session.baseRevision,
  ]);
}

function parseMcpEnvelope<T>(
  value: unknown,
  operation: string,
): McpEnvelope<T> {
  const record = asRecord(value);
  if (record === undefined) {
    throw new LocalApiBridgeError(
      `The CFLS Local_API returned a non-object response for '${operation}'.`,
    );
  }
  const connection = parseConnection(record["connection"], operation);
  const staleness = parseStaleness(record["staleness"], operation);
  const result = parseAgentResult<T>(record, operation);
  return result.ok
    ? { ok: true, data: result.data, connection, staleness }
    : { ok: false, error: result.error, connection, staleness };
}

function parseAgentResult<T>(
  value: unknown,
  operation: string,
): AgentResult<T> {
  const record = asRecord(value);
  if (record === undefined || typeof record["ok"] !== "boolean") {
    throw new LocalApiBridgeError(
      `The CFLS Local_API returned an invalid result for '${operation}'.`,
    );
  }
  if (record["ok"]) {
    if (!hasOwn(record, "data")) {
      throw new LocalApiBridgeError(
        `The CFLS Local_API success response for '${operation}' is missing data.`,
      );
    }
    return { ok: true, data: record["data"] as T };
  }

  const rawError = asRecord(record["error"]);
  if (
    rawError === undefined ||
    !isErrorCode(rawError["code"]) ||
    typeof rawError["message"] !== "string"
  ) {
    throw new LocalApiBridgeError(
      `The CFLS Local_API failure response for '${operation}' is invalid.`,
    );
  }
  const error: AgentResult<T> = {
    ok: false,
    error: {
      code: rawError["code"],
      message: rawError["message"],
      ...(hasOwn(rawError, "details") ? { details: rawError["details"] } : {}),
    },
  };
  return error;
}

function parseConnection(
  value: unknown,
  operation: string,
): ConnectionSnapshot {
  const record = asRecord(value);
  if (
    record === undefined ||
    (record["status"] !== "online" && record["status"] !== "offline") ||
    typeof record["hostUrl"] !== "string" ||
    (typeof record["lastSyncAt"] !== "string" && record["lastSyncAt"] !== null)
  ) {
    throw new LocalApiBridgeError(
      `The CFLS Local_API response for '${operation}' has invalid connection metadata.`,
    );
  }
  return {
    status: record["status"],
    hostUrl: record["hostUrl"],
    lastSyncAt: record["lastSyncAt"],
  };
}

function parseStaleness(value: unknown, operation: string): StalenessSnapshot {
  const record = asRecord(value);
  if (
    record === undefined ||
    typeof record["stale"] !== "boolean" ||
    (typeof record["secondsSinceSync"] !== "number" &&
      record["secondsSinceSync"] !== null)
  ) {
    throw new LocalApiBridgeError(
      `The CFLS Local_API response for '${operation}' has invalid staleness metadata.`,
    );
  }
  return {
    stale: record["stale"],
    secondsSinceSync: record["secondsSinceSync"],
  };
}

function toAgentResult<T>(envelope: McpEnvelope<T>): AgentResult<T> {
  return envelope.ok
    ? { ok: true, data: envelope.data as T }
    : { ok: false, error: envelope.error! };
}

function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  return data.toString("utf8");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasOwn(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function frameMessage(frame: Record<string, unknown>): string {
  return typeof frame["message"] === "string"
    ? frame["message"]
    : "no message provided";
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new LocalApiBridgeError(
          `Timed out after ${timeoutMs}ms while ${operation}.`,
        ),
      );
    }, timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}
