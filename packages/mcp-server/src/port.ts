/**
 * The {@link AgentPort} — the clean, transport-agnostic interface (a hexagonal
 * "port") between the Local_MCP_Server tools and the CoordinationAgent that
 * fronts the core-state engine and the WSS connection to the CoordinationHost.
 *
 * The MCP tool layer (see `./tools`) depends **only** on this port: it never
 * imports the network agent, the WSS client, or core-state directly. Task 9's
 * `CoordinationAgent` implements this interface for real; tests implement it with
 * an in-memory core-state-backed fake (see `./fake-agent`). This keeps the tool
 * surface and its request/response shapes (mirroring design §3.4) verifiable in
 * isolation.
 *
 * ## Query vs. mutation semantics
 * Query methods (`get*`, `subscribe*`) read the agent's locally-cached
 * authoritative view and succeed even while offline, returning possibly-stale
 * data flagged through the response envelope's `staleness` (Req 33.1).
 *
 * Mutation methods (`declareIntent`, `updateIntent`, `withdrawIntent`,
 * `acquireLock`, `releaseLock`) forward to the CoordinationHost. When the agent
 * is offline they MUST return an `OFFLINE_QUEUED` failure — the mutation is
 * queued or rejected and manual coordination is required — and MUST NOT falsely
 * report host acceptance (Req 4.8).
 *
 * Every method resolves to an {@link AgentResult}; connectivity/staleness for the
 * response envelope come from {@link AgentPort.getConnection} /
 * {@link AgentPort.getStaleness}, sampled per response (Req 4.7, 33.2).
 */

import type {
  Confidence,
  CoordinationUpdate,
  DependencyEdge,
  EdgeKind,
  RiskLevel,
  ScopeKind,
  SessionId,
} from "@cfls/protocol";

import type {
  AgentResult,
  ConnectionSnapshot,
  StalenessSnapshot,
} from "./envelope";

/** A value that may be returned synchronously or as a promise. */
export type MaybePromise<T> = T | Promise<T>;

// ---- Shared request fragments -------------------------------------------------

/** The Repository_Session identity carried by session-scoped tool requests. */
export type SessionRef = SessionId;

// ---- 1. get_risk_map (design §3.4 #1; Req 4.3, 24, 21, 22, 31.5) --------------

export interface GetRiskMapRequest {
  session: SessionRef;
}

/** A contributor to a path's risk, projected with member identity only (§3.4). */
export interface RiskContributor {
  memberId: string;
  kind: string;
}

/** The direct/indirect explanation attached to a risk-map path (Req 21.2, 22.4). */
export interface RiskExplanation {
  type: "direct" | "indirect";
  edges?: RiskEdge[];
  sharedContracts?: string[];
}

/** A dependency edge surfaced in an explanation (confidence travels with it). */
export interface RiskEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  confidence: Confidence;
}

/** A single per-path Risk_Map entry (design §3.4 #1). */
export interface RiskPathEntry {
  path: string;
  riskLevel: RiskLevel;
  contributors: RiskContributor[];
  explanation: RiskExplanation;
  /** True for coordination-required paths the agent must acknowledge (Req 13.5). */
  acknowledgementRequired: boolean;
}

export interface GetRiskMapData {
  paths: RiskPathEntry[];
  plannedFileCreations: { path: string; memberId: string }[];
  highestRevision: number;
}

// ---- Team activity (metadata only) ------------------------------------------

/** Request the active team projection for a Repository_Session. */
export interface GetTeamStatusRequest {
  session: SessionRef;
}

/** One active file and the coordination roles attributed to a member. */
export interface TeamActivityFile {
  path: string;
  roles: Array<"editing" | "soft-lock" | "intent" | "planned-create">;
}

/** A member-declared task reconstructed from their active Declared_Intent. */
export interface TeamActivityTask {
  intentId: string;
  description: string;
  modifyPaths: string[];
  createPaths: string[];
}

/** Active, metadata-only activity for a team member. */
export interface TeamMemberActivity {
  memberId: string;
  deviceIds: string[];
  files: TeamActivityFile[];
  tasks: TeamActivityTask[];
  lastEventRevision: number;
}

/** Live team activity available to local UI and coding agents. */
export interface GetTeamStatusData {
  teamId: string;
  members: TeamMemberActivity[];
  highestRevision: number;
}

// ---- 2. get_dependency_impact (design §3.4 #2; Req 23.1, 23.4, 23.5) ----------

export interface GetDependencyImpactRequest {
  paths: string[];
}

export interface DependencyImpact {
  path: string;
  directDependencies: string[];
  reverseDependencies: string[];
  sharedContracts: string[];
  riskLevel: RiskLevel;
  explanationPaths: { target: string; via: DependencyEdge[] }[];
  /** False => the path is absent from the graph and the result is empty (Req 23.5). */
  presentInGraph: boolean;
}

export interface GetDependencyImpactData {
  impacts: DependencyImpact[];
}

// ---- 3. get_dependencies / 4. get_dependents (design §3.4 #3, #4; Req 23.2/3) --

export interface GetDependenciesRequest {
  path: string;
}

export interface GetDependenciesData {
  dependsOn: string[];
  presentInGraph: boolean;
}

export interface GetDependentsRequest {
  path: string;
}

export interface GetDependentsData {
  dependedOnBy: string[];
  presentInGraph: boolean;
}

// ---- 5. declare_intent (design §3.4 #5; Req 4.4, 16.1–16.2, 16.5, 16.7) -------

export interface DeclareIntentRequest {
  session: SessionRef;
  modifyPaths: string[];
  createPaths: string[];
  description: string;
  /** Intent_Scope kind; defaults to `file` when omitted (Req 32.5). */
  scopeKind?: ScopeKind;
}

export interface DeclareIntentData {
  intentId: string;
  eventRevision: number;
  /** Create paths demoted to modifications because the path already exists (Req 16.5). */
  reclassified: { path: string; as: "modify"; reason: "path_exists" }[];
}

// ---- 6. update_intent (design §3.4 #6; Req 16.3, 16.8) ------------------------

export interface UpdateIntentRequest {
  intentId: string;
  modifyPaths: string[];
  createPaths: string[];
  description: string;
}

export interface UpdateIntentData {
  eventRevision: number;
}

// ---- 7. withdraw_intent (design §3.4 #7; Req 16.4, 16.8) ----------------------

export interface WithdrawIntentRequest {
  intentId: string;
}

export interface WithdrawIntentData {
  eventRevision: number;
}

// ---- 8. acquire_lock (design §3.4 #8; Req 12.1–12.4, 32.1, 32.4) --------------

export interface AcquireLockRequest {
  session: SessionRef;
  scope: string;
  scopeKind: ScopeKind;
}

export interface AcquireLockData {
  lockId?: string;
  eventRevision: number;
  granted: boolean;
  /** Set when the lock was contended and lost (Req 12.4). */
  concurrentClaim?: boolean;
  winner?: { memberId: string; eventRevision: number };
}

// ---- 9. release_lock (design §3.4 #9; Req 12.5–12.8) --------------------------

export interface ReleaseLockRequest {
  /** Release by explicit lock id (preferred) or by `scope` (Req 12.5). */
  lockId?: string;
  scope?: string;
}

export interface ReleaseLockData {
  released: boolean;
  eventRevision: number;
}

// ---- 10. subscribe_to_coordination_updates (design §3.4 #10; Req 25.1, 25.6) --

export interface SubscribeRequest {
  session: SessionRef;
}

export interface SubscribeData {
  subscriptionId: string;
}

// ---- 11. get_connection_status (design §3.4 #11; Req 4.6, 6.5, 27.4) ----------

export interface ConnectionStatusData {
  status: "online" | "offline";
  participants: { connected: string[]; offline: string[] };
  manualCoordinationRequired: boolean;
}

// ---- 12. get_project_session_status (design §3.4 #12; Req 4.6, 10) ------------

export interface ProjectSessionStatusData {
  session: {
    repoId: string;
    teamId: string;
    branch: string;
    baseRevision: string | null;
    manualConfig: boolean;
  };
  authorized: boolean;
  /** The requesting client's own Team_Member id (used for own-activity exclusion). */
  memberId: string;
}

/**
 * The interface the CoordinationAgent exposes to the Local_MCP_Server tools
 * (Task 9 implements it against the WSS agent + core-state; tests implement it
 * against an in-memory core-state fake).
 */
export interface AgentPort {
  /** Current CoordinationHost connectivity for the response envelope (Req 4.7). */
  getConnection(): ConnectionSnapshot;
  /** Current staleness for the response envelope (Req 33.2). */
  getStaleness(): StalenessSnapshot;

  // Queries — succeed while offline with possibly-stale data (Req 33.1).
  getRiskMap(req: GetRiskMapRequest): MaybePromise<AgentResult<GetRiskMapData>>;
  getTeamStatus(
    req: GetTeamStatusRequest,
  ): MaybePromise<AgentResult<GetTeamStatusData>>;
  getDependencyImpact(
    req: GetDependencyImpactRequest,
  ): MaybePromise<AgentResult<GetDependencyImpactData>>;
  getDependencies(
    req: GetDependenciesRequest,
  ): MaybePromise<AgentResult<GetDependenciesData>>;
  getDependents(
    req: GetDependentsRequest,
  ): MaybePromise<AgentResult<GetDependentsData>>;
  getConnectionStatus(): MaybePromise<AgentResult<ConnectionStatusData>>;
  getProjectSessionStatus(): MaybePromise<
    AgentResult<ProjectSessionStatusData>
  >;

  // Mutations — must return OFFLINE_QUEUED while offline (Req 4.8).
  declareIntent(
    req: DeclareIntentRequest,
  ): MaybePromise<AgentResult<DeclareIntentData>>;
  updateIntent(
    req: UpdateIntentRequest,
  ): MaybePromise<AgentResult<UpdateIntentData>>;
  withdrawIntent(
    req: WithdrawIntentRequest,
  ): MaybePromise<AgentResult<WithdrawIntentData>>;
  acquireLock(
    req: AcquireLockRequest,
  ): MaybePromise<AgentResult<AcquireLockData>>;
  releaseLock(
    req: ReleaseLockRequest,
  ): MaybePromise<AgentResult<ReleaseLockData>>;

  /**
   * Register a subscription for Coordination_Updates (Req 25.1). The optional
   * `onUpdate` callback is invoked by the agent as updates arrive; the streaming
   * transport itself is the agent's concern (Task 9).
   */
  subscribeToCoordinationUpdates(
    req: SubscribeRequest,
    onUpdate?: (update: CoordinationUpdate) => void,
  ): MaybePromise<AgentResult<SubscribeData>>;
}
