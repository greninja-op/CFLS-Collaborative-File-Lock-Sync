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
  normalizePath,
  type RepositoryRulesConfig,
  type SyncResponse,
} from "@cfls/core-state";
import { isExcludedPath } from "@cfls/dependency-analyzer";
import { createMcpServer } from "@cfls/mcp-server";
import type {
  CoordinationUpdate,
  DependencyGraph,
  MemberRef,
  SessionId,
  SessionStateSnapshot,
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
import { buildFolderGraph } from "./graph";
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

/** A saved-file signal is bounded activity, not permanent editor presence. */
const DEFAULT_WATCHER_ACTIVITY_TTL_MS = 30_000;
const LOCAL_CONTROL_PATH_PREFIXES = [".coordination/", ".cfls-cache/"];

/**
 * Normalize only paths that are demonstrably repository-relative. Local API
 * clients are untrusted even after loopback authentication, so never forward an
 * absolute or escaping editor path to the host.
 */
function repositoryRelativePath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    return undefined;
  }
  const slashNormalized = value.replace(/\\/g, "/");
  // Covers POSIX/UNC roots and both Windows drive-absolute and drive-relative
  // forms. Drive-relative paths have host-dependent resolution, so reject them
  // as well rather than guessing a repository root.
  if (slashNormalized.startsWith("/") || /^[A-Za-z]:/.test(slashNormalized)) {
    return undefined;
  }
  const normalized = normalizePath(value);
  if (
    normalized.length === 0 ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    isExcludedPath(normalized) ||
    normalized === ".coordination" ||
    normalized === ".cfls-cache" ||
    LOCAL_CONTROL_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  ) {
    return undefined;
  }
  return normalized;
}

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
  /** Duration a watcher-confirmed save remains editing before it ends locally. */
  watcherActivityTtlMs?: number;
  /** Connection tuning forwarded to {@link HostConnection}. */
  connection?: Partial<
    Pick<
      HostConnectionOptions,
      "heartbeatIntervalMs" | "backoff" | "autoReconnect"
    >
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
  private readonly coalescer = new Coalescer<{
    path: string;
    state: "editing" | "stopped";
  }>();
  private coalesceSeq = 0;
  private flushTimer: NodeJS.Timeout | undefined;

  /** Scopes this agent currently holds, re-asserted on reconnect (Req 9.6). */
  private readonly heldScopes = new Set<string>();

  /** The metadata-only Dependency_Graph built locally from the Authorized_Folder. */
  private localGraph: DependencyGraph | undefined;
  /** True when {@link localGraph} was built here (and should be uploaded), not injected. */
  private localGraphBuilt = false;

  /** Repository-relative paths currently open/being edited in this agent's editors. */
  private readonly openScopes = new Set<string>();
  /** Bounded end-of-activity timers for watcher-confirmed saves. */
  private readonly watcherActivityTimers = new Map<string, NodeJS.Timeout>();
  /** Per-path activity generation; lets a later save re-announce after stop. */
  private readonly watcherActivityGenerations = new Map<string, number>();
  /** Stops that elapsed while offline and must be sent after a successful sync. */
  private readonly pendingWatcherStops = new Set<string>();
  private readonly watcherActivityTtlMs: number;

  constructor(config: CoordinationAgentConfig) {
    super();
    this.config = config;
    this.localAuthToken = config.localAuthToken ?? generateLocalAuthToken();
    this.watcherActivityTtlMs =
      typeof config.watcherActivityTtlMs === "number" &&
      Number.isFinite(config.watcherActivityTtlMs) &&
      config.watcherActivityTtlMs > 0
        ? config.watcherActivityTtlMs
        : DEFAULT_WATCHER_ACTIVITY_TTL_MS;
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
      this.config.secretStore ??
      createSecretStore({ appSecret: this.config.session.repoId });
    this.deviceKey =
      this.config.deviceKey ?? (await loadOrCreateDeviceKey(store));

    // 2. Local encrypted cache; seed the offline view (Req 35.4).
    this.cache = new EncryptedCache({
      dir: this.config.cacheDir,
      passphrase: this.deviceKey.privateKey,
    });
    const cached = this.cache.load(this.config.session);
    // The host's replay gate is keyed by Device_ID, not Repository_Session.
    // A present-but-corrupt counter deliberately fails startup rather than
    // resetting to zero and replaying an already accepted signed event.
    const replayCounter = this.cache.loadReplayCounter();
    if (cached !== null) {
      this.view.loadSnapshot(this.config.session, cached);
    }
    // Cached (or empty) state is only authoritative after the first successful
    // sync. Keep local clients stale through the handshake/sync gap.
    this.view.markStale();

    // 3. WSS connection + host gateway (Req 6).
    this.connection = new HostConnection({
      hostUrl: this.config.hostUrl,
      session: this.config.session,
      deviceKey: this.deviceKey,
      invitation: this.config.invitation,
      initialReplayCounter: replayCounter,
      onReplayCounter: (counter) => this.cache!.saveReplayCounter(counter),
      ...(this.config.insecureTls !== undefined
        ? { insecureTls: this.config.insecureTls }
        : {}),
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

    // Resolve the metadata-only Dependency_Graph for risk analysis: an
    // explicitly provided graph wins; otherwise build one from the
    // Authorized_Folder and remember to upload it once connected (Req 19.1–19.3).
    this.localGraph = this.config.graph;
    if (
      this.localGraph === undefined &&
      this.config.authorizedFolder !== undefined
    ) {
      try {
        this.localGraph = buildFolderGraph(
          this.config.session,
          this.config.authorizedFolder,
        );
        this.localGraphBuilt = true;
      } catch {
        // Best-effort: risk still works from a host-shared graph if this fails.
      }
    }

    // 4. Shared port + embedded MCP server (Req 2.6, 31.1).
    this.port = new AgentCoordinationPort({
      session: this.config.session,
      self: this.config.self,
      gateway: this.gateway,
      rules: this.config.rules,
      view: this.view,
      ...(this.localGraph !== undefined ? { graph: this.localGraph } : {}),
      ...(this.config.authorized !== undefined
        ? { authorized: this.config.authorized }
        : {}),
      ...(this.config.manualConfig !== undefined
        ? { manualConfig: this.config.manualConfig }
        : {}),
    });
    this.mcpServer = createMcpServer(this.port);

    // Track held locks for reconnect re-assert (Req 9.6).
    this.connection.on("update", (u: CoordinationUpdate) => {
      this.trackHeld(u);
      // RealHostGateway/AgentCoordinationPort registered their listeners before
      // this one, so the view has applied the authoritative update by now. Save
      // every active transition so a service restart retains live task status.
      this.persistCache();
    });
    // Adopt the session's shared Dependency_Graph whenever the host shares one
    // so every agent computes indirect risk against the same graph (Req 19, 20).
    this.connection.on("graph", (graph: DependencyGraph) => {
      this.port?.setGraph(graph);
    });
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
      ...(this.config.localApiPort !== undefined
        ? { wsPort: this.config.localApiPort }
        : {}),
      ...(this.config.enableNamedPipe !== undefined
        ? { enableNamedPipe: this.config.enableNamedPipe }
        : {}),
      handlers: {
        request: (method, params) => {
          // Editor activity (open/edit/close/rename/delete) from the extension
          // is translated into host presence + soft-lock coordination so
          // teammates see it live (not only on file save via the watcher).
          if (method === "editor_event") {
            this.handleEditorEvent(params);
            return Promise.resolve({ ok: true });
          }
          // The editor's periodic liveness ping (Req 26.6): record it and ack.
          // It keeps the editor→agent link warm; the agent runs its own host
          // heartbeat separately.
          if (method === "heartbeat") {
            return Promise.resolve({ ok: true });
          }
          return dispatchLocalRequest(this.port!, method, params).then(
            (env) => env,
          );
        },
        subscribe: (params, push) =>
          Promise.resolve(
            this.port!.subscribeToCoordinationUpdates(
              { session: (params as { session: SessionId }).session },
              push,
            ),
          ),
        unsubscribe: (subscriptionId) =>
          this.port!.unsubscribeFromCoordinationUpdates(subscriptionId),
      },
    });
    const localApiAddress = await this.localApi.start();

    // 6. Authorized_Folder watcher (Req 2.7, 2.8).
    if (this.config.authorizedFolder !== undefined) {
      this.watcher = new FolderWatcher({
        folder: this.config.authorizedFolder,
      });
      this.watcher.on("change", (event: FileChangeEvent) =>
        this.onFileChange(event),
      );
      this.watcher.start();
    }

    // 7. Connect (with backoff). A failed initial connect leaves the agent in
    //    Offline_State serving the cached view (Req 6.4, 33.1).
    try {
      await this.connection.connect();
      // Publish the locally-built graph so the host holds it and shares it with
      // the rest of the session (Req 19.3). An injected graph is not re-uploaded.
      if (this.localGraphBuilt && this.localGraph !== undefined) {
        this.connection.send("dep.snapshot", { graph: this.localGraph });
      }
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
    // `auth.ok` makes the transport online before the sync response arrives.
    // Do not let that small window make cached data look authoritative.
    this.view.markStale();
    try {
      const from = this.view.highestApplied(this.config.session);
      const response: SyncResponse = await this.connection.requestSync(from);
      this.view.applySync(this.config.session, response);
      this.flushPendingWatcherStops();
      // Re-assert still-held locks so the host reinstates them (Req 9.6).
      for (const scope of this.heldScopes) {
        this.connection.send("lock.acquire", {
          scope,
          scopeKind: "file",
          mode: "soft",
        });
      }
      // Re-publish the locally-built graph so the host reflects any changes made
      // to the checkout while this agent was offline (Req 19.3, 19.4).
      if (this.localGraphBuilt && this.localGraph !== undefined) {
        this.connection.send("dep.snapshot", { graph: this.localGraph });
      }
      this.persistCache();
      this.emit("synced", response.kind);
    } catch {
      // A successful TLS/auth handshake is not enough to make coordination
      // fresh: until sync converges, local clients must keep seeing stale data.
      this.view.markStale();
      this.persistCache();
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

  /**
   * Translate an Editor_Event from the extension into live host coordination:
   * opening/editing a file reports editing presence and claims a soft lock on
   * that path (once), closing it reports end-of-editing and releases the lock,
   * and renames/deletions are forwarded as path changes. This is what makes a
   * teammate's live editing visible to others without waiting for a save.
   */
  private handleEditorEvent(event: unknown): void {
    const connection = this.connection;
    if (connection === undefined || !connection.isOnline()) {
      return;
    }
    const e = (event ?? {}) as {
      kind?: string;
      path?: string;
      oldPath?: string;
    };
    const path = repositoryRelativePath(e.path);

    switch (e.kind) {
      case "file_opened":
      case "active_editor_changed":
      case "editing_started":
      case "file_saved": {
        if (path === undefined || path.length === 0) {
          return;
        }
        // Only announce the first time a path becomes active, to avoid a flood
        // of presence/lock messages on every keystroke (Req 34 spirit).
        if (!this.openScopes.has(path)) {
          // A pending watcher save may still flush as editing; that is harmless
          // here because the editor has just taken ownership of this presence.
          this.clearWatcherActivity(path);
          this.openScopes.add(path);
          connection.send("presence.report", { path, state: "editing" });
          connection.send("lock.acquire", {
            scope: path,
            scopeKind: "file",
            mode: "soft",
          });
        }
        return;
      }
      case "file_closed": {
        if (path === undefined || path.length === 0) {
          return;
        }
        if (this.openScopes.delete(path)) {
          this.clearWatcherActivity(path, true);
          connection.send("presence.report", { path, state: "stopped" });
          connection.send("lock.release", { scope: path });
        }
        return;
      }
      case "file_renamed": {
        const oldPath = repositoryRelativePath(e.oldPath);
        if (oldPath !== undefined && path !== undefined) {
          this.clearWatcherActivity(oldPath, true);
          this.clearWatcherActivity(path, true);
          connection.send("path.renamed", {
            fromPath: oldPath,
            toPath: path,
          });
        }
        return;
      }
      case "file_deleted": {
        if (path !== undefined) {
          this.clearWatcherActivity(path, true);
          connection.send("path.deleted", { path });
        }
        return;
      }
      default:
        // workspace_opened and unknown kinds need no host coordination.
        return;
    }
  }

  private onFileChange(event: FileChangeEvent): void {
    const connection = this.connection;
    if (connection === undefined) {
      return;
    }
    for (const message of reconcileFileChange(event)) {
      if (message.type === "presence.report") {
        const path = message.payload.path;
        if (typeof path !== "string") {
          continue;
        }
        const activityGeneration = this.scheduleWatcherActivityEnd(path);
        this.enqueueWatcherPresence(path, "editing", activityGeneration);
        continue;
      }
      if (message.type === "path.renamed") {
        const fromPath = message.payload.fromPath;
        const toPath = message.payload.toPath;
        if (typeof fromPath === "string") {
          this.clearWatcherActivity(fromPath, true);
        }
        if (typeof toPath === "string") {
          this.clearWatcherActivity(toPath, true);
        }
      } else if (message.type === "path.deleted") {
        const path = message.payload.path;
        if (typeof path === "string") {
          this.clearWatcherActivity(path, true);
        }
      }
      // Path renames/deletes/creations are transmitted promptly (metadata only).
      connection.send(message.type, message.payload as never);
    }
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(
      () => this.flushOutbound(),
      this.coalescer.windowMs,
    );
    this.flushTimer.unref?.();
  }

  /** Flush the coalesced outbound presence events to the host (Req 34). */
  flushOutbound(): void {
    const connection = this.connection;
    if (connection === undefined || !connection.isOnline()) {
      return;
    }
    for (const event of this.coalescer.flush()) {
      connection.send("presence.report", {
        path: event.payload.path,
        state: event.payload.state,
      });
    }
  }

  /** Enqueue the latest watcher-derived state so cancellation supersedes saves. */
  private enqueueWatcherPresence(
    path: string,
    state: "editing" | "stopped",
    generation: number,
  ): void {
    this.coalesceSeq += 1;
    this.coalescer.enqueue({
      seq: this.coalesceSeq,
      kind: "presence",
      path,
      member: this.config.self,
      stateSignature: `${path}:${state}:${generation}`,
      payload: { path, state },
    });
  }

  /** Start/reset a bounded watcher-only editing signal for one saved path. */
  private scheduleWatcherActivityEnd(path: string): number {
    const hadTimer = this.watcherActivityTimers.has(path);
    this.clearWatcherActivityTimer(path);
    this.pendingWatcherStops.delete(path);
    const generation = hadTimer
      ? (this.watcherActivityGenerations.get(path) ?? 1)
      : (this.watcherActivityGenerations.get(path) ?? 0) + 1;
    this.watcherActivityGenerations.set(path, generation);
    const timer = setTimeout(() => {
      this.watcherActivityTimers.delete(path);
      this.endWatcherActivity(path);
    }, this.watcherActivityTtlMs);
    timer.unref?.();
    this.watcherActivityTimers.set(path, timer);
    return generation;
  }

  /** Cancel pending watcher activity and any deferred stop for one path. */
  private clearWatcherActivity(path: string, queueStop = false): void {
    this.clearWatcherActivityTimer(path);
    this.pendingWatcherStops.delete(path);
    if (queueStop) {
      if (this.enqueueWatcherStop(path)) {
        this.sendWatcherStop(path);
      }
    }
  }

  private clearWatcherActivityTimer(path: string): void {
    const timer = this.watcherActivityTimers.get(path);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.watcherActivityTimers.delete(path);
    }
  }

  /** Emit an end-of-editing only when an editor has not claimed the path. */
  private endWatcherActivity(path: string): void {
    if (this.openScopes.has(path)) {
      return;
    }
    const connection = this.connection;
    if (connection === undefined || !connection.isOnline()) {
      this.pendingWatcherStops.add(path);
      return;
    }
    this.pendingWatcherStops.delete(path);
    if (this.enqueueWatcherStop(path)) {
      this.sendWatcherStop(path);
    }
  }

  /** A higher-sequence stopped state prevents a buffered saved/editing event. */
  private enqueueWatcherStop(path: string): boolean {
    const generation = this.watcherActivityGenerations.get(path);
    if (generation === undefined) {
      return false;
    }
    this.enqueueWatcherPresence(path, "stopped", generation);
    return true;
  }

  /** Send the stop promptly while its coalesced copy guards a later flush. */
  private sendWatcherStop(path: string): void {
    const connection = this.connection;
    if (connection !== undefined && connection.isOnline()) {
      connection.send("presence.report", { path, state: "stopped" });
    }
  }

  /** Send expired watcher stops only after the view has successfully synced. */
  private flushPendingWatcherStops(): void {
    for (const path of this.pendingWatcherStops) {
      this.endWatcherActivity(path);
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
        intents: this.snapshotIntents(entries),
        highestRevision,
      });
    } catch {
      // Never let cache persistence failures affect coordination.
    }
  }

  /**
   * Rebuild snapshot intents from path-level coordination entries. The cache
   * stores one Declared_Intent per `(intentId, memberId, deviceId)`, preserving
   * both modify and planned-creation roles for the team panel/MCP projection
   * after a clean service restart. No source content is introduced here.
   */
  private snapshotIntents(
    entries: readonly CoordinationUpdate[],
  ): SessionStateSnapshot["intents"] {
    interface IntentGroup {
      intentId: string;
      owner: MemberRef;
      description: string;
      modifyPaths: Set<string>;
      createPaths: Set<string>;
      eventRevision: number;
    }

    const groups = new Map<string, IntentGroup>();
    for (const entry of entries) {
      if (
        (entry.entryType !== "intent" &&
          entry.entryType !== "planned_file_creation") ||
        entry.path === undefined
      ) {
        continue;
      }

      // Current hosts always provide intent metadata. Retain legacy entries as
      // a one-path intent instead of silently losing active coordination state.
      const activity = entry.intent;
      const intentId =
        activity?.intentId ??
        `legacy-${entry.entryType}-${entry.eventRevision}-${entry.path}`;
      const key = JSON.stringify([
        intentId,
        entry.member.memberId,
        entry.member.deviceId,
      ]);
      let group = groups.get(key);
      if (group === undefined) {
        group = {
          intentId,
          owner: { ...entry.member },
          description: activity?.description ?? "",
          modifyPaths: new Set(),
          createPaths: new Set(),
          eventRevision: entry.eventRevision,
        };
        groups.set(key, group);
      } else if (entry.eventRevision >= group.eventRevision) {
        group.eventRevision = entry.eventRevision;
        if (activity !== undefined) {
          group.description = activity.description;
        }
      }

      if (entry.entryType === "intent") {
        group.modifyPaths.add(entry.path);
      } else {
        group.createPaths.add(entry.path);
      }
    }

    return [...groups.values()]
      .map((group) => ({
        intentId: group.intentId,
        owner: group.owner,
        agentId: group.owner.deviceId,
        modifyPaths: [...group.modifyPaths].sort((a, b) => a.localeCompare(b)),
        createPaths: [...group.createPaths]
          .sort((a, b) => a.localeCompare(b))
          .map((path) => ({ path })),
        scopeKind: "file" as const,
        branch: this.config.session.branch,
        description: group.description,
        eventRevision: group.eventRevision,
      }))
      .sort((a, b) => {
        const aKey = `${a.intentId}\u0000${a.owner.memberId}\u0000${a.owner.deviceId}`;
        const bKey = `${b.intentId}\u0000${b.owner.memberId}\u0000${b.owner.deviceId}`;
        return aKey.localeCompare(bKey);
      });
  }

  /** Stop the agent and release all resources. */
  async stop(): Promise<void> {
    if (this.flushTimer !== undefined) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    for (const timer of this.watcherActivityTimers.values()) {
      clearTimeout(timer);
    }
    this.watcherActivityTimers.clear();
    this.watcherActivityGenerations.clear();
    this.pendingWatcherStops.clear();
    this.watcher?.stop();
    try {
      await this.localApi?.stop();
    } finally {
      // The Local_API normally removes each per-connection subscription first.
      // This is the final safety net if its transport shutdown itself faults.
      this.port?.dispose();
      this.connection?.close();
      this.persistCache();
    }
  }
}
