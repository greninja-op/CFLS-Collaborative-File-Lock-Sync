/**
 * {@link AgentCoordinationPort} — the CoordinationAgent's real implementation of
 * the `@cfls/mcp-server` {@link AgentPort} (task 9.3; Req 2.6, 4.x, 31.1–31.5).
 *
 * This is the single object every local client — the embedded Local_MCP_Server
 * and the Editor_Extension — talks to, so all clients under one device identity
 * share one consistent host view (multi-client fan-in, Req 31.1). Queries read
 * the cached {@link AgentView} and succeed even while offline with stale-marked
 * data (Req 33.1); mutations are forwarded to the CoordinationHost through the
 * {@link HostGateway} and return `OFFLINE_QUEUED` while offline, never falsely
 * reporting host acceptance (Req 4.8). The requesting member's own activity is
 * excluded from its own Risk_Map (Req 31.5).
 */

import {
  normalizePath,
  normalizePathKey,
  resolveMode,
  type RepositoryRulesConfig,
} from "@cfls/core-state";
import type {
  CoordinationUpdate,
  DependencyEdge,
  DependencyGraph,
  MemberRef,
  RiskMapEntry,
  SessionId,
} from "@cfls/protocol";
import type {
  AcquireLockData,
  AcquireLockRequest,
  AgentPort,
  AgentResult,
  ConnectionSnapshot,
  ConnectionStatusData,
  DeclareIntentData,
  DeclareIntentRequest,
  DependencyImpact,
  GetDependenciesData,
  GetDependenciesRequest,
  GetDependencyImpactData,
  GetDependencyImpactRequest,
  GetDependentsData,
  GetDependentsRequest,
  GetRiskMapData,
  GetRiskMapRequest,
  ProjectSessionStatusData,
  ReleaseLockData,
  ReleaseLockRequest,
  RiskPathEntry,
  StalenessSnapshot,
  SubscribeData,
  SubscribeRequest,
  UpdateIntentData,
  UpdateIntentRequest,
  WithdrawIntentData,
  WithdrawIntentRequest,
} from "@cfls/mcp-server";

import type { HostGateway } from "./gateway";
import { AgentView } from "./view";

/** True when a glob pattern is malformed (unbalanced brackets or empty) (Req 32.4). */
function isMalformedGlob(glob: string): boolean {
  if (glob.trim().length === 0) {
    return true;
  }
  let depth = 0;
  for (const ch of glob) {
    if (ch === "[") {
      depth += 1;
    } else if (ch === "]") {
      depth -= 1;
      if (depth < 0) {
        return true;
      }
    }
  }
  return depth !== 0;
}

/** Options for an {@link AgentCoordinationPort}. */
export interface AgentPortOptions {
  session: SessionId;
  self: MemberRef;
  gateway: HostGateway;
  rules: RepositoryRulesConfig;
  view?: AgentView;
  graph?: DependencyGraph;
  authorized?: boolean;
  manualConfig?: boolean;
  connectedMembers?: string[];
  offlineMembers?: string[];
}

/** The agent's real, host-backed {@link AgentPort} (design §3.2, §3.4). */
export class AgentCoordinationPort implements AgentPort {
  readonly view: AgentView;
  private readonly session: SessionId;
  private readonly self: MemberRef;
  private readonly gateway: HostGateway;
  private readonly rules: RepositoryRulesConfig;
  /** The shared metadata-only Dependency_Graph; updated as the host shares one. */
  private graph: DependencyGraph | undefined;
  private authorized: boolean;
  private readonly manualConfig: boolean;
  private connectedMembers: string[];
  private offlineMembers: string[];

  private subscriptionSeq = 0;

  constructor(options: AgentPortOptions) {
    this.session = options.session;
    this.self = options.self;
    this.gateway = options.gateway;
    this.rules = options.rules;
    this.view = options.view ?? new AgentView();
    this.graph = options.graph;
    this.authorized = options.authorized ?? true;
    this.manualConfig = options.manualConfig ?? false;
    this.connectedMembers = options.connectedMembers ?? [options.self.memberId];
    this.offlineMembers = options.offlineMembers ?? [];

    // One shared view fed by every host broadcast (multi-client fan-in, Req 31.1).
    this.gateway.on("update", (update: CoordinationUpdate) => {
      this.view.applyUpdate(this.session, update);
    });
  }

  // ---- Envelope inputs ------------------------------------------------------

  getConnection(): ConnectionSnapshot {
    return this.gateway.getConnection();
  }

  getStaleness(): StalenessSnapshot {
    return this.gateway.getStaleness();
  }

  // ---- Guards ---------------------------------------------------------------

  private sameSession(session: SessionId): boolean {
    return (
      session.repoId === this.session.repoId &&
      session.teamId === this.session.teamId &&
      session.branch === this.session.branch &&
      (session.baseRevision ?? null) === (this.session.baseRevision ?? null)
    );
  }

  private notAuthorized<T>(): AgentResult<T> {
    return {
      ok: false,
      error: {
        code: "AUTH_NOT_AUTHORIZED",
        message: "The agent is not authorized for this Repository_Session.",
      },
    };
  }

  private sessionNotFound<T>(): AgentResult<T> {
    return {
      ok: false,
      error: { code: "NOT_FOUND", message: "Unknown Repository_Session." },
    };
  }

  // ---- Queries --------------------------------------------------------------

  getRiskMap(req: GetRiskMapRequest): AgentResult<GetRiskMapData> {
    if (!this.sameSession(req.session)) {
      return this.sessionNotFound();
    }
    if (!this.authorized) {
      return this.notAuthorized();
    }
    const entries = this.view.riskMap(
      this.session,
      this.self,
      this.rules,
      this.graph,
    );
    const paths: RiskPathEntry[] = entries.map((entry: RiskMapEntry) => {
      const explanation: RiskPathEntry["explanation"] = {
        type: entry.explanation.type,
      };
      if (entry.explanation.edges !== undefined) {
        explanation.edges = entry.explanation.edges;
      }
      if (entry.explanation.sharedContracts !== undefined) {
        explanation.sharedContracts = entry.explanation.sharedContracts;
      }
      return {
        path: entry.path,
        riskLevel: entry.riskLevel,
        contributors: entry.contributors.map((c) => ({
          memberId: c.member.memberId,
          kind: c.kind,
        })),
        explanation,
        acknowledgementRequired: entry.acknowledgementRequired,
      };
    });
    return {
      ok: true,
      data: {
        paths,
        plannedFileCreations: this.view.plannedCreations(
          this.session,
          this.self,
        ),
        highestRevision: this.view.highestApplied(this.session),
      },
    };
  }

  getDependencyImpact(
    req: GetDependencyImpactRequest,
  ): AgentResult<GetDependencyImpactData> {
    const impacts: DependencyImpact[] = req.paths.map((rawPath) => {
      const path = normalizePath(rawPath);
      if (!this.presentInGraph(path)) {
        return {
          path,
          directDependencies: [],
          reverseDependencies: [],
          sharedContracts: [],
          riskLevel: resolveMode(path, this.rules),
          explanationPaths: [],
          presentInGraph: false,
        };
      }
      const reverse = this.dependedOnBy(path);
      return {
        path,
        directDependencies: this.dependsOn(path),
        reverseDependencies: reverse,
        sharedContracts: [],
        riskLevel: resolveMode(path, this.rules),
        explanationPaths: reverse.map((target) => ({
          target,
          via: this.edgesBetween(target, path),
        })),
        presentInGraph: true,
      };
    });
    return { ok: true, data: { impacts } };
  }

  getDependencies(
    req: GetDependenciesRequest,
  ): AgentResult<GetDependenciesData> {
    const path = normalizePath(req.path);
    return {
      ok: true,
      data: {
        dependsOn: this.dependsOn(path),
        presentInGraph: this.presentInGraph(path),
      },
    };
  }

  getDependents(req: GetDependentsRequest): AgentResult<GetDependentsData> {
    const path = normalizePath(req.path);
    return {
      ok: true,
      data: {
        dependedOnBy: this.dependedOnBy(path),
        presentInGraph: this.presentInGraph(path),
      },
    };
  }

  getConnectionStatus(): AgentResult<ConnectionStatusData> {
    const online = this.gateway.online();
    return {
      ok: true,
      data: {
        status: online ? "online" : "offline",
        participants: {
          connected: [...this.connectedMembers],
          offline: [...this.offlineMembers],
        },
        manualCoordinationRequired: !online,
      },
    };
  }

  getProjectSessionStatus(): AgentResult<ProjectSessionStatusData> {
    return {
      ok: true,
      data: {
        session: {
          repoId: this.session.repoId,
          teamId: this.session.teamId,
          branch: this.session.branch,
          baseRevision: this.session.baseRevision,
          manualConfig: this.manualConfig,
        },
        authorized: this.authorized,
        memberId: this.self.memberId,
      },
    };
  }

  // ---- Mutations ------------------------------------------------------------

  async acquireLock(
    req: AcquireLockRequest,
  ): Promise<AgentResult<AcquireLockData>> {
    if (!this.sameSession(req.session)) {
      return this.sessionNotFound();
    }
    if (!this.authorized) {
      return this.notAuthorized();
    }
    if (req.scopeKind === "glob" && isMalformedGlob(req.scope)) {
      return {
        ok: false,
        error: {
          code: "FORMAT_ERROR",
          message: `Malformed glob: '${req.scope}'.`,
        },
      };
    }
    const result = await this.gateway.transmit({
      type: "lock.acquire",
      payload: {
        scope: req.scope,
        scopeKind: req.scopeKind,
        mode: resolveMode(req.scope, this.rules),
      },
    });
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    // Contention: the host's winning broadcast names a DIFFERENT member (Req 12.4).
    if (
      result.update !== undefined &&
      result.update.member.memberId !== this.self.memberId
    ) {
      return {
        ok: true,
        data: {
          eventRevision: result.eventRevision,
          granted: false,
          concurrentClaim: true,
          winner: {
            memberId: result.update.member.memberId,
            eventRevision: result.update.eventRevision,
          },
        },
      };
    }
    return {
      ok: true,
      data: {
        lockId: result.eventId,
        eventRevision: result.eventRevision,
        granted: true,
      },
    };
  }

  async releaseLock(
    req: ReleaseLockRequest,
  ): Promise<AgentResult<ReleaseLockData>> {
    const result = await this.gateway.transmit({
      type: "lock.release",
      payload: {
        ...(req.lockId !== undefined ? { lockId: req.lockId } : {}),
        ...(req.scope !== undefined ? { scope: req.scope } : {}),
      },
    });
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    return {
      ok: true,
      data: { released: true, eventRevision: result.eventRevision },
    };
  }

  async declareIntent(
    req: DeclareIntentRequest,
  ): Promise<AgentResult<DeclareIntentData>> {
    if (!this.sameSession(req.session)) {
      return this.sessionNotFound();
    }
    if (!this.authorized) {
      return this.notAuthorized();
    }
    const result = await this.gateway.transmit({
      type: "intent.declare",
      payload: {
        modifyPaths: req.modifyPaths,
        createPaths: req.createPaths,
        description: req.description,
      },
    });
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    return {
      ok: true,
      data: {
        intentId: result.eventId,
        eventRevision: result.eventRevision,
        reclassified: [],
      },
    };
  }

  async updateIntent(
    req: UpdateIntentRequest,
  ): Promise<AgentResult<UpdateIntentData>> {
    const result = await this.gateway.transmit({
      type: "intent.update",
      payload: {
        intentId: req.intentId,
        modifyPaths: req.modifyPaths,
        createPaths: req.createPaths,
        description: req.description,
      },
    });
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    return { ok: true, data: { eventRevision: result.eventRevision } };
  }

  async withdrawIntent(
    req: WithdrawIntentRequest,
  ): Promise<AgentResult<WithdrawIntentData>> {
    const result = await this.gateway.transmit({
      type: "intent.withdraw",
      payload: { intentId: req.intentId },
    });
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    return { ok: true, data: { eventRevision: result.eventRevision } };
  }

  subscribeToCoordinationUpdates(
    req: SubscribeRequest,
    onUpdate?: (update: CoordinationUpdate) => void,
  ): AgentResult<SubscribeData> {
    if (!this.sameSession(req.session)) {
      return this.sessionNotFound();
    }
    if (!this.authorized) {
      return this.notAuthorized();
    }
    if (onUpdate !== undefined) {
      this.gateway.on("update", onUpdate);
    }
    return {
      ok: true,
      data: { subscriptionId: `sub-${(this.subscriptionSeq += 1)}` },
    };
  }

  // ---- Authorization / participant controls ---------------------------------

  setAuthorized(authorized: boolean): void {
    this.authorized = authorized;
  }

  setParticipants(connected: string[], offline: string[]): void {
    this.connectedMembers = connected;
    this.offlineMembers = offline;
  }

  /**
   * Replace the shared metadata-only Dependency_Graph used for dependency/risk
   * queries (Req 19, 20). Called when the agent builds a local graph from the
   * Authorized_Folder and when the host shares an updated graph for the session.
   */
  setGraph(graph: DependencyGraph): void {
    this.graph = graph;
  }

  /** The current shared Dependency_Graph, or `undefined` when none is known. */
  currentGraph(): DependencyGraph | undefined {
    return this.graph;
  }

  // ---- Dependency-graph helpers --------------------------------------------

  private allEdges(): DependencyEdge[] {
    if (this.graph === undefined) {
      return [];
    }
    return this.graph.modules.flatMap((module) => module.edges);
  }

  private dependsOn(path: string): string[] {
    const key = normalizePathKey(path);
    const out = new Set<string>();
    for (const edge of this.allEdges()) {
      if (normalizePathKey(edge.from) === key) {
        out.add(normalizePath(edge.to));
      }
    }
    return [...out].sort((a, b) => a.localeCompare(b));
  }

  private dependedOnBy(path: string): string[] {
    const key = normalizePathKey(path);
    const out = new Set<string>();
    for (const edge of this.allEdges()) {
      if (normalizePathKey(edge.to) === key) {
        out.add(normalizePath(edge.from));
      }
    }
    return [...out].sort((a, b) => a.localeCompare(b));
  }

  private edgesBetween(from: string, to: string): DependencyEdge[] {
    const fromKey = normalizePathKey(from);
    const toKey = normalizePathKey(to);
    return this.allEdges().filter(
      (edge) =>
        normalizePathKey(edge.from) === fromKey &&
        normalizePathKey(edge.to) === toKey,
    );
  }

  private presentInGraph(path: string): boolean {
    if (this.graph === undefined) {
      return false;
    }
    const key = normalizePathKey(path);
    for (const module of this.graph.modules) {
      if (normalizePathKey(module.sourceFile) === key) {
        return true;
      }
      for (const edge of module.edges) {
        if (
          normalizePathKey(edge.from) === key ||
          normalizePathKey(edge.to) === key
        ) {
          return true;
        }
      }
    }
    return false;
  }
}
