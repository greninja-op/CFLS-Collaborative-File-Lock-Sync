/**
 * The CoordinationAgent assembly (task 9.1–9.6; design §3.2).
 *
 * Wires the per-user agent together: one outbound WSS {@link HostConnection}
 * (Req 2.3, 6), the loopback-only {@link LocalApiServer} (Req 2.4, 2.5), the
 * embedded Local_MCP_Server serving the shared {@link AgentCoordinationPort}
 * (Req 2.6, 31.1), the Authorized_Folder {@link FolderWatcher} (Req 2.7, 2.8),
 * the {@link EncryptedCache} with reconnect sync + re-assert (Req 9, 35), and the
 * `@cfls/security` credential store for the Device_Key (Req 5.1, 5.8, 5.9).
 *
 * Bootstrap fails closed if secure storage is unavailable (Req 5.9) and never
 * claims hard-lock safety while offline (Req 6.5, 33; design §8.4).
 */

import { EventEmitter } from "node:events";

import {
  Coalescer,
  type RepositoryRulesConfig,
  type SyncResponse,
} from "@cfls/core-state";
import { createMcpServer } from "@cfls/mcp-server";
import type {
  CoordinationUpdate,
  DependencyGraph,
  MemberRef,
  SessionId,
} from "@cfls/protocol";
import {
  createSecretStore,
  type DeviceKey,
  type SecretStore,
} from "@cfls/security";

import { EncryptedCache } from "./cache";
import { HostConnection, type HostConnectionOptions } from "./connection";
import { dispatchLocalRequest } from "./dispatch";
import { RealHostGateway } from "./gateway";
import { loadOrCreateDeviceKey } from "./keystore";
import {
  LocalApiServer,
  generateLocalAuthToken,
  type LocalApiAddress,
  type LocalAuthToken,
} from "./local-api";
import { AgentCoordinationPort } from "./port";
import { AgentView } from "./view";
import {
  FolderWatcher,
  reconcileFileChange,
  type FileChangeEvent,
} from "./watcher";

/** Configuration for a {@link CoordinationAgent}. */
export interface CoordinationAgentConfig {
  /** The Repository_Session this agent coordinates. */
  session: SessionId;
  /** This agent's Team_Member/device identity. */
  self: MemberRef;
  /** The configured Host_URL (`wss://…`); never hardcoded (Req 6.2). */
  hostUrl: string;
  /** base64 Signed_Invitation chaining to an admin (Req 5.5). */
  invitation: string;
  /** The team's Repository_Rules_Config (already loaded/validated, Req 15). */
  rules: RepositoryRulesConfig;
  /** The Authorized_Folder to watch (absolute); never scanned elsewhere (Req 2.7). */
  authorizedFolder?: string;
  /** Directory for the local encrypted cache (Req 35). */
  cacheDir: string;
  /** Optional metadata-only Dependency_Graph for dependency/risk queries. */
  graph?: DependencyGraph;
  /** Skip TLS validation for a local dev/test host only (never production). */
  insecureTls?: boolean;
  /** Whether this agent is authorized for the session (default true). */
  authorized?: boolean;
  /** Whether the session came from the manual-config fallback (Req 10.6). */
  manualConfig?: boolean;
  /** Pre-provided Device_Key (tests); otherwise loaded from the credential store. */
  deviceKey?: DeviceKey;
  /** Pre-provided secret store (tests); otherwise the composite OS/file store. */
  secretStore?: SecretStore;
  /** Local_Auth_Token override; otherwise a fresh per-session token is generated. */
  localAuthToken?: LocalAuthToken;
  /** Loopback WebSocket port for the Local_API (0 ⇒ ephemeral). */
  localApiPort?: number;
  /** Enable the named-pipe Local_API transport (default: win32). */
  enableNamedPipe?: boolean;
  /** Connection tuning forwarded to {@link HostConnection}. */
  connection?: Partial<
    Pick<HostConnectionOptions, "heartbeatIntervalMs" | "backoff" | "autoReconnect">
  >;
}

/** A running agent's live handles. */
export interface RunningAgent {
  deviceKey: DeviceKey;
  localAuthToken: LocalAuthToken;
  localApiAddress: LocalApiAddress;
}

/**
 * The per-user CoordinationAgent. Construct with a {@link CoordinationAgentConfig},
 * then {@link start} to bring up the connection, Local_API, MCP server, and
 * watcher; {@link stop} tears everything down.
 */
export class CoordinationAgent extends EventEmitter {
  readonly view = new AgentView();
  private readonly config: CoordinationAgentConfig;

  private deviceKey: DeviceKey | undefined;
  private cache: EncryptedCache | undefined;
  private connection: HostConnection | undefined;
  private gateway: RealHostGateway | undefined;
  private port: AgentCoordinationPort | undefined;
  private mcpServer: ReturnType<typeof createMcpServer> | undefined;
  private localApi: LocalApiServer | undefined;
  private watcher: FolderWatcher | undefined;
  private localAuthToken: LocalAuthToken;

  /** Coalescer for outbound presence/lock bursts (Req 34). */
  private readonly coalescer = new Coalescer<{ path: string }>();
  private coalesceSeq = 0;
  private flushTimer: NodeJS.Timeout | undefined;

  /** Scopes this agent currently holds, re-asserted on reconnect (Req 9.6). */
  private readonly heldScopes = new Set<string>();

  constructor(config: CoordinationAgentConfig) {
    super();
    this.config = config;
    this.localAuthToken = config.localAuthToken ?? generateLocalAuthToken();
  }

  /** The embedded Local_MCP_Server (for connecting a transport). */
  mcp(): ReturnType<typeof createMcpServer> {
    if (this.mcpServer === undefined) {
      throw new Error("Agent not started.");
    }
    return this.mcpServer;
  }

  /** The shared AgentPort every local client uses (multi-client fan-in). */
  agentPort(): AgentCoordinationPort {
    if (this.port === undefined) {
      throw new Error("Agent not started.");
    }
    return this.port;
  }

  /** The live WSS connection (diagnostics/tests). */
  hostConnection(): HostConnection {
    if (this.connection === undefined) {
      throw new Error("Agent not started.");
    }
    return this.connection;
  }

  /**
   * Bootstrap the agent (design §3.2): load/generate the Device_Key (failing
   * closed if secure storage is unavailable — Req 5.9), seed the view from the
   * encrypted cache, connect to the host with backoff, embed the MCP server on
   * the shared port, start the loopback Local_API, and begin watching the
   * Authorized_Folder.
   */
  async start(): Promise<RunningAgent> {
    // 1. Device_Key from the credential store — fail closed (Req 5.1, 5.9).
    const store =
      this.config.secretStore ?? createSecretStore({ appSecret: this.config.session.repoId });
    this.deviceKey =
      this.config.deviceKey ?? (await loadOrCreateDeviceKey(store));

    // 2. Local encrypted cache; seed the offline view (Req 35.4).
    this.cache = new EncryptedCache({
      dir: this.config.cacheDir,
      passphrase: this.deviceKey.privateKey,
    });
    const cached = this.cache.load(this.config.session);
    if (cached !== null) {
      this.view.loadSnapshot(this.config.session, cached);
    }

    // 3. WSS connection + host gateway (Req 6).
    this.connection = new HostConnection({
      hostUrl: this.config.hostUrl,
      session: this.config.session,
      deviceKey: this.deviceKey,
      invitation: this.config.invitation,
      ...(this.config.insecureTls !== undefined ? { insecureTls: this.config.insecureTls } : {}),
      ...(this.config.connection?.heartbeatIntervalMs !== undefined
        ? { heartbeatIntervalMs: this.config.connection.heartbeatIntervalMs }
        : {}),
      ...(this.config.connection?.backoff !== undefined
        ? { backoff: this.config.connection.backoff }
        : {}),
      ...(this.config.connection?.autoReconnect !== undefined
        ? { autoReconnect: this.config.connection.autoReconnect }
        : {}),
    });
    this.gateway = new RealHostGateway(this.connection);

    // 4. Shared port + embedded MCP server (Req 2.6, 31.1).
    this.port = new AgentCoordinationPort({
      session: this.config.session,
      self: this.config.self,
      gateway: this.gateway,
      rules: this.config.rules,
      view: this.view,
      ...(this.config.graph !== undefined ? { graph: this.config.graph } : {}),
      ...(this.config.authorized !== undefined ? { authorized: this.config.authorized } : {}),
      ...(this.config.manualConfig !== undefined ? { manualConfig: this.config.manualConfig } : {}),
    });
    this.mcpServer = createMcpServer(this.port);

    // Track held locks for reconnect re-assert (Req 9.6).
    this.connection.on("update", (u: CoordinationUpdate) => this.trackHeld(u));
    this.connection.on("state", (state: string) => {
      if (state === "offline") {
        this.view.markStale();
        this.persistCache();
      }
      this.emit("state", state);
    });
    this.connection.on("online", () => {
      void this.onReconnect();
    });

    // 5. Local_API (loopback only) (Req 2.4, 2.5, 2.9).
    this.localApi = new LocalApiServer({
      token: this.localAuthToken,
      ...(this.config.localApiPort !== undefined ? { wsPort: this.config.localApiPort } : {}),
      ...(this.config.enableNamedPipe !== undefined
        ? { enableNamedPipe: this.config.enableNamedPipe }
        : {}),
      handlers: {
        request: (method, params) =>
          dispatchLocalRequest(this.port!, method, params).then((env) => env),
        subscribe: (params, push) =>
          Promise.resolve(
            this.port!.subscribeToCoordinationUpdates(
              { session: (params as { session: SessionId }).session },
              push,
            ),
          ),
      },
    });
    const localApiAddress = await this.localApi.start();

    // 6. Authorized_Folder watcher (Req 2.7, 2.8).
    if (this.config.authorizedFolder !== undefined) {
      this.watcher = new FolderWatcher({ folder: this.config.authorizedFolder });
      this.watcher.on("change", (event: FileChangeEvent) => this.onFileChange(event));
      this.watcher.start();
    }

    // 7. Connect (with backoff). A failed initial connect leaves the agent in
    //    Offline_State serving the cached view (Req 6.4, 33.1).
    try {
      await this.connection.connect();
    } catch {
      this.view.markStale();
    }

    this.startFlushTimer();

    return {
      deviceKey: this.deviceKey,
      localAuthToken: this.localAuthToken,
      localApiAddress,
    };
  }

  /** On (re)connect: sync from the highest applied revision and re-assert held state (Req 9.6). */
  private async onReconnect(): Promise<void> {
    if (this.connection === undefined) {
      return;
    }
    try {
      const from = this.view.highestApplied(this.config.session);
      const response: SyncResponse = await this.connection.requestSync(from);
      this.view.applySync(this.config.session, response);
      // Re-assert still-held locks so the host reinstates them (Req 9.6).
      for (const scope of this.heldScopes) {
        this.connection.send("lock.acquire", {
          scope,
          scopeKind: "file",
          mode: "soft",
        });
      }
      this.persistCache();
      this.emit("synced", response.kind);
    } catch {
      // Sync failed; remain stale until the next reconnect.
      this.emit("sync-failed");
    }
  }

  private trackHeld(update: CoordinationUpdate): void {
    if (
      update.entryType === "soft_lock" &&
      update.member.memberId === this.config.self.memberId &&
      update.path !== undefined
    ) {
      if (update.op === "added") {
        this.heldScopes.add(update.path);
      } else {
        this.heldScopes.delete(update.path);
      }
    }
  }

  private onFileChange(event: FileChangeEvent): void {
    const connection = this.connection;
    if (connection === undefined) {
      return;
    }
    for (const message of reconcileFileChange(event)) {
      if (message.type === "presence.report") {
        // Coalesce presence bursts (Req 34); flushed on the window timer.
        this.coalesceSeq += 1;
        this.coalescer.enqueue({
          seq: this.coalesceSeq,
          kind: "presence",
          path: message.payload.path as string,
          member: this.config.self,
          stateSignature: `${message.payload.path}:${message.payload.state}`,
          payload: { path: message.payload.path as string },
        });
        continue;
      }
      // Path renames/deletes/creations are transmitted promptly (metadata only).
      connection.send(
        message.type,
        message.payload as never,
      );
    }
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => this.flushOutbound(), this.coalescer.windowMs);
    this.flushTimer.unref?.();
  }

  /** Flush the coalesced outbound presence events to the host (Req 34). */
  flushOutbound(): void {
    const connection = this.connection;
    if (connection === undefined || !connection.isOnline()) {
      return;
    }
    for (const event of this.coalescer.flush()) {
      connection.send("presence.report", { path: event.payload.path, state: "editing" });
    }
  }

  private persistCache(): void {
    if (this.cache === undefined) {
      return;
    }
    try {
      // Persist a projected snapshot of the current cached view (metadata only).
      const entries = this.view.entries(this.config.session);
      const highestRevision = this.view.highestApplied(this.config.session);
      this.cache.save(this.config.session, {
        session: this.config.session,
        locks: entries
          .filter((e) => e.entryType === "soft_lock" && e.path !== undefined)
          .map((e) => ({
            lockId: `cache-${e.eventRevision}`,
            scope: e.path as string,
            scopeKind: "file" as const,
            mode: "soft" as const,
            holder: e.member,
            branch: this.config.session.branch,
            eventRevision: e.eventRevision,
            acquiredAt: "",
            concurrent: false,
          })),
        presence: entries
          .filter((e) => e.entryType === "presence" && e.path !== undefined)
          .map((e) => ({
            member: e.member,
            path: e.path as string,
            state: "editing" as const,
            eventRevision: e.eventRevision,
          })),
        intents: [],
        highestRevision,
      });
    } catch {
      // Never let cache persistence failures affect coordination.
    }
  }

  /** Stop the agent and release all resources. */
  async stop(): Promise<void> {
    if (this.flushTimer !== undefined) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.watcher?.stop();
    await this.localApi?.stop();
    this.connection?.close();
    this.persistCache();
  }
}
