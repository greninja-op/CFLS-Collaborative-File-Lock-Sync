/**
 * The agent's single, consistent cached view of authoritative coordination state
 * (task 9.3, 9.5; Req 9, 31.1–31.5, 33, 35; design §3.2, §4.6).
 *
 * Every local client (the embedded Local_MCP_Server and the Editor_Extension)
 * reads this one view, so multiple clients under one device identity always see
 * the same host state (multi-client fan-in, Req 31.1). The view is the set of
 * active {@link CoordinationUpdate} entries maintained by `@cfls/core-state`'s
 * {@link AgentSyncCache}: it is fed by host broadcasts and reconnect sync, is
 * idempotent/order-preserving (never re-applies an event, never misses one), and
 * exposes a converged, possibly-stale snapshot while offline (Req 33.1).
 *
 * For risk queries the cached entries are reconstructed into the
 * lock/presence/intent shapes {@link buildRiskMap} consumes; the requesting
 * member's own activity is excluded from its own Risk_Map (Req 31.5) by
 * `buildRiskMap` itself.
 */

import {
  AgentSyncCache,
  buildRiskMap,
  normalizePath,
  resolveMode,
  type RepositoryRulesConfig,
  type SyncResponse,
} from "@cfls/core-state";
import type {
  CoordinationUpdate,
  DeclaredIntent,
  DependencyGraph,
  Lock,
  MemberRef,
  Presence,
  RiskMapEntry,
  SessionId,
  SessionStateSnapshot,
} from "@cfls/protocol";

/** A planned-file-creation surfaced in the Risk_Map (design §3.4 #1). */
export interface PlannedCreation {
  path: string;
  memberId: string;
}

/**
 * The agent-side converged view of one or more Repository_Sessions. Thin wrapper
 * over {@link AgentSyncCache} that adds risk-map reconstruction and staleness.
 */
export class AgentView {
  private readonly cache = new AgentSyncCache();

  /** Apply a single host broadcast to the view (idempotent by revision). */
  applyUpdate(session: SessionId, update: CoordinationUpdate): void {
    this.cache.applyEvents(session, [update]);
  }

  /** Apply a batch of host broadcasts to the view. */
  applyUpdates(
    session: SessionId,
    updates: readonly CoordinationUpdate[],
  ): void {
    this.cache.applyEvents(session, updates);
  }

  /** Apply a reconnect {@link SyncResponse}, converging + clearing staleness. */
  applySync(session: SessionId, response: SyncResponse): void {
    this.cache.applySync(session, response);
  }

  /** Seed the view from a locally-cached snapshot (offline start, Req 35.4). */
  loadSnapshot(session: SessionId, snapshot: SessionStateSnapshot): void {
    this.cache.applySnapshot(session, snapshot);
  }

  /** Mark the view stale on connectivity loss (Req 33.2). */
  markStale(): void {
    this.cache.markStale();
  }

  /** Whether the cached view is currently stale (Offline_State). */
  isStale(): boolean {
    return this.cache.isStale();
  }

  /** The highest Event_Revision applied for a session (reconnect `fromRevision`). */
  highestApplied(session: SessionId): number {
    return this.cache.highestApplied(session);
  }

  /** The raw active coordination entries for a session (converged state). */
  entries(session: SessionId): CoordinationUpdate[] {
    return this.cache.cachedEntries(session);
  }

  /**
   * Reconstruct the lock/presence/intent projections needed to build a Risk_Map
   * from the cached entries. Lock modes are resolved from the shared rules
   * config (the broadcast carries only the path), matching how the host itself
   * classifies risk (design §10.1).
   */
  private reconstruct(
    session: SessionId,
    rules: RepositoryRulesConfig,
  ): { locks: Lock[]; presence: Presence[]; intents: DeclaredIntent[] } {
    const locks: Lock[] = [];
    const presence: Presence[] = [];
    const intents: DeclaredIntent[] = [];
    let seq = 0;
    for (const entry of this.entries(session)) {
      const path = entry.path === undefined ? "" : normalizePath(entry.path);
      switch (entry.entryType) {
        case "soft_lock":
          locks.push({
            lockId: `cached-${(seq += 1)}`,
            scope: path,
            scopeKind: "file",
            mode: resolveMode(path, rules),
            holder: entry.member,
            branch: session.branch,
            eventRevision: entry.eventRevision,
            acquiredAt: "",
            concurrent: false,
          });
          break;
        case "presence":
          presence.push({
            member: entry.member,
            path,
            state: "editing",
            eventRevision: entry.eventRevision,
          });
          break;
        case "intent":
          intents.push({
            intentId: `cached-intent-${(seq += 1)}`,
            owner: entry.member,
            agentId: entry.member.deviceId,
            modifyPaths: [path],
            createPaths: [],
            scopeKind: "file",
            branch: session.branch,
            description: "",
            eventRevision: entry.eventRevision,
          });
          break;
        case "planned_file_creation":
          intents.push({
            intentId: `cached-planned-${(seq += 1)}`,
            owner: entry.member,
            agentId: entry.member.deviceId,
            modifyPaths: [],
            createPaths: [{ path }],
            scopeKind: "file",
            branch: session.branch,
            description: "",
            eventRevision: entry.eventRevision,
          });
          break;
        default:
          break; // dependency_risk is derived from the graph, not cached entries.
      }
    }
    return { locks, presence, intents };
  }

  /**
   * Project the Risk_Map for `requester`, excluding its own activity (Req 31.5).
   * `graph` supplies indirect/reverse-dependency/shared-contract risk (Req 22).
   */
  riskMap(
    session: SessionId,
    requester: MemberRef,
    rules: RepositoryRulesConfig,
    graph?: DependencyGraph,
  ): RiskMapEntry[] {
    const { locks, presence, intents } = this.reconstruct(session, rules);
    return buildRiskMap({
      requester,
      branch: session.branch,
      locks,
      presence,
      intents,
      rules,
      ...(graph !== undefined ? { graph } : {}),
    });
  }

  /** Planned file creations by OTHER members (own excluded, Req 31.5). */
  plannedCreations(
    session: SessionId,
    requester: MemberRef,
  ): PlannedCreation[] {
    const out = new Map<string, PlannedCreation>();
    for (const entry of this.entries(session)) {
      if (
        entry.entryType !== "planned_file_creation" ||
        entry.path === undefined ||
        entry.member.memberId === requester.memberId
      ) {
        continue;
      }
      const path = normalizePath(entry.path);
      out.set(`${path}\u0000${entry.member.memberId}`, {
        path,
        memberId: entry.member.memberId,
      });
    }
    return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
  }
}
