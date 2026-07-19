/**
 * Pure state→view-model rendering (task 11.3; Req 3.3, 3.4, 3.6, 33.3;
 * design §3.5).
 *
 * {@link buildCoordinationViewModel} is a **pure function**: it maps the agent's
 * `get_risk_map` result plus the connection/staleness snapshots onto a
 * display-oriented {@link CoordinationViewModel}. The VS Code adapter renders the
 * view model; keeping the projection pure makes the rendering rules unit-testable
 * with no editor runtime.
 *
 * Per affected path the view model surfaces active soft / coordination-required /
 * hard locks, presence, declared intents, planned file creations, and indirect
 * dependency risk — each attributed to the contributing member identity
 * (Req 3.4). It also carries an explicit offline/stale indicator (Req 3.6, 33.3).
 */

import type {
  ConnectionSnapshot,
  GetRiskMapData,
  RiskEdge,
  StalenessSnapshot,
} from "@cfls/mcp-server";
import type { RiskLevel } from "@cfls/protocol";

/** Indirect dependency risk for a path, with its explanation (Req 3.4, 22). */
export interface IndirectRiskView {
  edges: RiskEdge[];
  sharedContracts: string[];
}

/** The rendered coordination state for a single repository-relative path. */
export interface PathView {
  path: string;
  /** The highest resolved Risk_Level for the path (soft/coordination-required/hard). */
  riskLevel: RiskLevel;
  /** Member ids holding an active Soft_Lock on the path. */
  softLockMembers: string[];
  /** Member ids holding an active Coordination_Required_Lock on the path. */
  coordinationRequiredMembers: string[];
  /** Member ids holding an active Hard_Lock on the path. */
  hardLockMembers: string[];
  /** Member ids currently present/editing the path. */
  presenceMembers: string[];
  /** Member ids with a Declared_Intent touching the path. */
  intentMembers: string[];
  /** Member ids contributing indirect dependency risk to the path. */
  dependencyRiskMembers: string[];
  /** Indirect dependency risk explanation, when the path is indirectly at risk. */
  indirectRisk: IndirectRiskView | null;
  /** True for coordination-required paths needing explicit acknowledgement (Req 13.5). */
  acknowledgementRequired: boolean;
}

/** A planned file creation surfaced by another member (Req 3.4). */
export interface PlannedCreationView {
  path: string;
  memberId: string;
}

/** The full rendered coordination view for a Repository_Session. */
export interface CoordinationViewModel {
  paths: PathView[];
  plannedFileCreations: PlannedCreationView[];
  /** True while the local agent is in Offline_State (Req 3.6, 33.3). */
  offline: boolean;
  /** True when served coordination data may be stale (Req 33.2, 33.3). */
  stale: boolean;
  /** Seconds since the last successful host sync, or null when never synced. */
  secondsSinceSync: number | null;
  /** A short human-readable status line for the offline/stale indicator. */
  statusText: string;
}

/** The inputs the extension holds to render coordination state. */
export interface CoordinationSnapshot {
  riskMap: GetRiskMapData;
  connection: ConnectionSnapshot;
  staleness: StalenessSnapshot;
}

/** Collect the member ids for contributors of a given kind, de-duplicated. */
function membersOfKind(
  contributors: { memberId: string; kind: string }[],
  kind: string,
): string[] {
  const seen = new Set<string>();
  for (const c of contributors) {
    if (c.kind === kind) {
      seen.add(c.memberId);
    }
  }
  return [...seen];
}

/** Compose the offline/stale status line (Req 3.6, 33.3). */
export function statusLine(
  connection: ConnectionSnapshot,
  staleness: StalenessSnapshot,
): string {
  if (connection.status === "offline") {
    return "Offline — coordination data may be stale; manual coordination required";
  }
  if (staleness.stale) {
    return "Stale — reconnecting to the coordination agent";
  }
  return "Online";
}

/**
 * Project a {@link CoordinationSnapshot} onto the display-oriented
 * {@link CoordinationViewModel} (Req 3.3, 3.4, 3.6). Pure and deterministic.
 */
export function buildCoordinationViewModel(
  snapshot: CoordinationSnapshot,
): CoordinationViewModel {
  const offline = snapshot.connection.status === "offline";
  const stale = snapshot.staleness.stale;

  const paths: PathView[] = snapshot.riskMap.paths.map((entry) => {
    const indirect =
      entry.explanation.type === "indirect"
        ? {
            edges: entry.explanation.edges ?? [],
            sharedContracts: entry.explanation.sharedContracts ?? [],
          }
        : null;
    return {
      path: entry.path,
      riskLevel: entry.riskLevel,
      softLockMembers: membersOfKind(entry.contributors, "soft_lock"),
      coordinationRequiredMembers: membersOfKind(
        entry.contributors,
        "coordination_required_lock",
      ),
      hardLockMembers: membersOfKind(entry.contributors, "hard_lock"),
      presenceMembers: membersOfKind(entry.contributors, "presence"),
      intentMembers: membersOfKind(entry.contributors, "intent"),
      dependencyRiskMembers: membersOfKind(entry.contributors, "dependency"),
      indirectRisk: indirect,
      acknowledgementRequired: entry.acknowledgementRequired,
    };
  });

  return {
    paths,
    plannedFileCreations: snapshot.riskMap.plannedFileCreations.map((p) => ({
      path: p.path,
      memberId: p.memberId,
    })),
    offline,
    stale,
    secondsSinceSync: snapshot.staleness.secondsSinceSync,
    statusText: statusLine(snapshot.connection, snapshot.staleness),
  };
}

/** Find the rendered view for a specific path, or `undefined`. */
export function findPathView(
  vm: CoordinationViewModel,
  path: string,
): PathView | undefined {
  return vm.paths.find((p) => p.path === path);
}
