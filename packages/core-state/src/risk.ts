/**
 * Risk classification, Risk_Map projection, and own-activity exclusion
 * (task 4.14; Req 21.1–21.3, 22.1–22.5, 24.1–24.7, 31.5; design §7.8, §10.1).
 *
 * This module turns the raw coordination state — active locks, presence,
 * Declared_Intents, the metadata-only Dependency_Graph, and the shared
 * Repository_Rules_Config — into a per-path {@link RiskMapEntry} projection that
 * an AI_Agent can act on programmatically. It is the pure realization of design
 * §10.1's three-level derivation and §7.8's host-side risk computation.
 *
 * ## Risk_Level derivation (Req 24; design §10.1)
 * For a path `p` under the query Branch_Context `b`:
 * ```
 * mode      = resolveMode(p, rules)               // §6, defaults to soft
 * contended = other-member lock/presence/intent on p under a conflicting branch
 * depRisk   = indirect dependency / reverse-dependency / shared-contract risk
 *
 * riskLevel =
 *     (mode === 'hard'                 && contended) ? 'hard'
 *   : (mode === 'coordination-required'&& contended) ? 'coordination-required'
 *   :                                                   'soft'
 * ```
 * `hard`/`coordination-required` are **never** assigned without a matching rule
 * (Req 24.6): {@link resolveMode} only returns those modes when a config rule
 * matches, and escalation additionally requires the path to be contended under a
 * conflicting branch (Req 24.2–24.3). Every other relevant path — presence, an
 * advisory soft lock, a non-conflicting intent, or an indirect dependency risk —
 * is classified `soft` (Req 24.4).
 *
 * ## Direct conflicts (Req 21)
 * A path with an active lock, Presence_Event, or Declared_Intent by **another**
 * Team_Member under a **conflicting** Branch_Context is a direct conflict
 * (Req 21.1). Its entry names the affected path, the contributing member
 * identities, and the type of contention (Req 21.2). Activity by another member
 * on the same path under a **different** Branch_Context is a reduced/no direct
 * conflict, recorded with the distinct branch surfaced in the contributor's
 * contention kind (Req 21.3).
 *
 * ## Indirect / reverse-dependency / shared-contract risks (Req 22)
 * Using the Dependency_Graph, two paths changed by **different** members that are
 * connected by a `Dependency_Edge` are both flagged as indirect
 * dependency-risk conflicts (Req 22.1). The endpoint that is depended-on carries
 * a reverse-dependency contribution (Req 22.2). Two members touching distinct
 * paths whose {@link PublicContractFingerprint} hashes match share a public
 * contract (Req 22.3). The contributing `Dependency_Edge`s are attached verbatim
 * so their `confidence` travels with the risk (Req 22.4); low/unknown-confidence
 * edges are still reported (as `soft` indirect risk) rather than as a confirmed
 * conflict (Req 22.5).
 *
 * ## Own-activity exclusion (Req 31.5; Property 13)
 * The Risk_Map is projected **for a requesting Team_Member**. That member's own
 * active locks and Declared_Intents (and presence) — across every one of its
 * devices/local clients — are excluded so the member's own activity is never
 * reported as a risk against itself. Exclusion is by `memberId` so all of a
 * member's devices collapse to one identity (Req 31.2, 31.3, 31.5).
 *
 * ## Acknowledgement (Req 13.5)
 * An entry classified `coordination-required` sets `acknowledgementRequired` so
 * the querying agent knows it must acknowledge/override before proceeding
 * (design §10.3).
 *
 * The projection is deterministic and order-independent: entries are keyed by a
 * platform-aware path match key, contributors and edges are de-duplicated, and
 * the result is sorted by path.
 */

import type {
  DeclaredIntent,
  DependencyEdge,
  DependencyGraph,
  Lock,
  MemberRef,
  Presence,
  RiskLevel,
  RiskMapEntry,
  ScopeKind,
} from "@cfls/protocol";

import {
  normalizePath,
  normalizePathKey,
  type PlatformCaseSensitivity,
} from "./path";
import { resolveMode, type RepositoryRulesConfig } from "./rules";

/** Contention-kind labels surfaced in {@link RiskMapEntry.contributors} (Req 21.2, 24.7). */
export const ContentionKind = {
  /** An active Soft_Lock. */
  SoftLock: "soft_lock",
  /** An active Coordination_Required_Lock. */
  CoordinationRequiredLock: "coordination_required_lock",
  /** An active Hard_Lock. */
  HardLock: "hard_lock",
  /** A Presence_Event (started/editing). */
  Presence: "presence",
  /** A Declared_Intent to modify the path. */
  Intent: "intent",
  /** A Planned_File_Creation for the path. */
  PlannedCreation: "planned-creation",
  /** The path depends on another member's changed path (forward edge). */
  Dependency: "dependency",
  /** The path is depended on by another member's changed path (reverse edge). */
  ReverseDependency: "reverse-dependency",
  /** The path shares a Public_Contract_Fingerprint with another member's path. */
  SharedContract: "shared-contract",
} as const;

/**
 * The contributor {@link ContentionKind} for a lock of the given coordination
 * mode (Req 21.2). Carrying the lock's mode in the contributor kind lets a
 * consumer (e.g. the Editor_Extension's cooperative hard-stop) identify the
 * holder of a *hard* lock specifically, rather than a generic "lock".
 */
export function lockContentionKind(mode: RiskLevel): string {
  return mode === "hard"
    ? ContentionKind.HardLock
    : mode === "coordination-required"
      ? ContentionKind.CoordinationRequiredLock
      : ContentionKind.SoftLock;
}

/**
 * Inputs to {@link buildRiskMap}. All coordination state is supplied as plain
 * arrays (typically pulled from the lock/presence/intent registries) so the
 * projection stays pure and trivially testable.
 */
export interface RiskMapContext {
  /** The Team_Member the Risk_Map is projected for; its own activity is excluded (Req 31.5). */
  readonly requester: MemberRef;
  /** The Branch_Context conflicts are assessed under (design §10.1's `b`). */
  readonly branch: string;
  /** Active locks for the session (winning and concurrent). */
  readonly locks: readonly Lock[];
  /** Presence entries for the session. `stopped` entries are ignored. */
  readonly presence: readonly Presence[];
  /** Active Declared_Intents for the session. */
  readonly intents: readonly DeclaredIntent[];
  /** The shared Repository_Rules_Config used to resolve each path's mode (Req 24.5). */
  readonly rules: RepositoryRulesConfig;
  /** Optional metadata-only Dependency_Graph for indirect/reverse/shared-contract risk (Req 22). */
  readonly graph?: DependencyGraph;
  /** Platform case-sensitivity used to key paths (defaults to the platform default). */
  readonly sensitivity?: PlatformCaseSensitivity;
}

/** A member's contribution to a candidate path, before de-duplication. */
interface Contribution {
  readonly member: MemberRef;
  readonly kind: string;
}

/** Internal aggregation for a single candidate path/scope. */
interface Candidate {
  /** Original normalized spelling (Req 10.3) used for display and rule matching. */
  displayPath: string;
  /** How the scope is expressed (file/folder/glob). */
  scopeKind: ScopeKind;
  /** De-duplicated contributors keyed by `memberId\0deviceId\0kind`. */
  readonly contributors: Map<string, Contribution>;
  /** True when another member contends on this path under the query branch (Req 21.1). */
  directContended: boolean;
  /** True when an indirect dependency/reverse/shared-contract risk applies (Req 22). */
  indirect: boolean;
  /** De-duplicated contributing Dependency_Edges keyed by `from\0to\0kind`. */
  readonly edges: Map<string, DependencyEdge>;
  /** Shared Public_Contract_Fingerprint ids contributing to the risk. */
  readonly sharedContracts: Set<string>;
}

/** Whether a member reference identifies the requesting member (by member, not device). */
function isRequester(member: MemberRef, requester: MemberRef): boolean {
  return member.memberId === requester.memberId;
}

/**
 * Project the Risk_Map for the requesting member (Req 24.1, 24.7). Excludes the
 * requester's own locks/intents/presence (Req 31.5), classifies each remaining
 * relevant path into a {@link RiskLevel} (Req 24), and attaches contributor
 * identities plus a direct/indirect explanation path (Req 21.2, 22, 24.7).
 */
export function buildRiskMap(context: RiskMapContext): RiskMapEntry[] {
  const { requester, branch, sensitivity } = context;
  const candidates = new Map<string, Candidate>();

  // Per-path index of the OTHER members that touched it, used to detect
  // cross-member dependency and shared-contract risk (Req 22.1–22.3).
  const membersByPathKey = new Map<string, Map<string, MemberRef>>();

  // The requester's own file-path keys. Indirect risk never introduces one of
  // these as an entry, preserving own-activity exclusion (Req 31.5).
  const ownKeys = new Set<string>();

  const keyOf = (path: string, scopeKind: ScopeKind): string =>
    scopeKind === "glob"
      ? `glob\u0000${path}`
      : normalizePathKey(path, sensitivity);

  const candidateFor = (path: string, scopeKind: ScopeKind): Candidate => {
    const display = scopeKind === "glob" ? path : normalizePath(path);
    const key = keyOf(display, scopeKind);
    let candidate = candidates.get(key);
    if (candidate === undefined) {
      candidate = {
        displayPath: display,
        scopeKind,
        contributors: new Map(),
        directContended: false,
        indirect: false,
        edges: new Map(),
        sharedContracts: new Set(),
      };
      candidates.set(key, candidate);
    }
    return candidate;
  };

  const addContributor = (
    candidate: Candidate,
    member: MemberRef,
    kind: string,
  ): void => {
    const id = `${member.memberId}\u0000${member.deviceId}\u0000${kind}`;
    if (!candidate.contributors.has(id)) {
      candidate.contributors.set(id, { member, kind });
    }
  };

  const noteMemberPath = (
    path: string,
    scopeKind: ScopeKind,
    member: MemberRef,
  ): void => {
    if (scopeKind === "glob") {
      return; // globs/folders never align with file-path dependency edges.
    }
    const key = normalizePathKey(path, sensitivity);
    let members = membersByPathKey.get(key);
    if (members === undefined) {
      members = new Map();
      membersByPathKey.set(key, members);
    }
    if (!members.has(member.memberId)) {
      members.set(member.memberId, member);
    }
  };

  // ---- 1. Direct activity: locks, presence, intents (Req 21) ----------------
  // Each contribution is recorded against its candidate path. Same-branch
  // activity is a direct conflict (Req 21.1); different-branch activity is a
  // reduced/no conflict whose distinct Branch_Context is surfaced (Req 21.3).

  const recordActivity = (
    path: string,
    scopeKind: ScopeKind,
    member: MemberRef,
    baseKind: string,
    activityBranch: string | undefined,
  ): void => {
    if (isRequester(member, requester)) {
      // Own-activity exclusion (Req 31.5). Remember the requester's own file
      // paths so indirect risk never re-introduces them as an entry.
      if (scopeKind !== "glob") {
        ownKeys.add(normalizePathKey(path, sensitivity));
      }
      return;
    }
    const candidate = candidateFor(path, scopeKind);
    // Presence carries no Branch_Context (it is session-scoped, and the session
    // is already branch-scoped) so it always contends under the query branch.
    const sameBranch =
      activityBranch === undefined || activityBranch === branch;
    if (sameBranch) {
      candidate.directContended = true;
      addContributor(candidate, member, baseKind);
    } else {
      // Reduced/no direct conflict: report the distinct Branch_Context (Req 21.3).
      addContributor(
        candidate,
        member,
        `${baseKind} (branch: ${activityBranch})`,
      );
    }
    noteMemberPath(candidate.displayPath, scopeKind, member);
  };

  for (const lock of context.locks) {
    recordActivity(
      lock.scope,
      lock.scopeKind,
      lock.holder,
      lockContentionKind(lock.mode),
      lock.branch,
    );
  }

  for (const entry of context.presence) {
    if (entry.state === "stopped") {
      continue;
    }
    recordActivity(
      entry.path,
      "file",
      entry.member,
      ContentionKind.Presence,
      undefined,
    );
  }

  for (const intent of context.intents) {
    for (const modifyPath of intent.modifyPaths) {
      recordActivity(
        modifyPath,
        intent.scopeKind,
        intent.owner,
        ContentionKind.Intent,
        intent.branch,
      );
    }
    for (const creation of intent.createPaths) {
      recordActivity(
        creation.path,
        intent.scopeKind,
        intent.owner,
        ContentionKind.PlannedCreation,
        intent.branch,
      );
    }
  }

  // ---- 2. Indirect & reverse-dependency risk via Dependency_Edges (Req 22) --
  if (context.graph !== undefined) {
    const edgeKey = (edge: DependencyEdge): string =>
      `${edge.from}\u0000${edge.to}\u0000${edge.kind}`;

    const membersOf = (key: string): Map<string, MemberRef> =>
      membersByPathKey.get(key) ?? new Map();

    // A path `self` connected by `edge` to another changed path carries an
    // indirect risk from the members changing that other path (Req 22.1–22.2).
    // The candidate is created on demand so a connected path that is not itself
    // directly contended still surfaces as an indirect-only risk — except the
    // requester's own paths, which are never re-introduced (Req 31.5).
    const linkEndpoint = (
      selfPath: string,
      selfKey: string,
      selfMembers: Map<string, MemberRef>,
      otherMembers: Map<string, MemberRef>,
      edge: DependencyEdge,
      kind: string,
    ): void => {
      if (ownKeys.has(selfKey)) {
        return;
      }
      const contributors: MemberRef[] = [];
      for (const [memberId, member] of otherMembers) {
        if (selfMembers.has(memberId)) {
          continue; // same member changed both ends — not a cross-member risk.
        }
        contributors.push(member);
      }
      if (contributors.length === 0) {
        return;
      }
      const candidate = candidateFor(selfPath, "file");
      for (const member of contributors) {
        addContributor(candidate, member, kind);
      }
      candidate.indirect = true;
      candidate.edges.set(edgeKey(edge), edge);
    };

    for (const module of context.graph.modules) {
      for (const edge of module.edges) {
        const fromKey = normalizePathKey(edge.from, sensitivity);
        const toKey = normalizePathKey(edge.to, sensitivity);
        const fromMembers = membersOf(fromKey);
        const toMembers = membersOf(toKey);
        // At least one endpoint must be changed by another member for the edge
        // to contribute a cross-member risk.
        if (fromMembers.size === 0 && toMembers.size === 0) {
          continue;
        }
        // `from` depends on `to`: when `to` is changed, `from` carries a forward
        // dependency risk on the members changing `to` (Req 22.1). When `from`
        // is changed, `to` carries a reverse-dependency risk on the members
        // changing `from` (Req 22.2).
        linkEndpoint(
          edge.from,
          fromKey,
          fromMembers,
          toMembers,
          edge,
          ContentionKind.Dependency,
        );
        linkEndpoint(
          edge.to,
          toKey,
          toMembers,
          fromMembers,
          edge,
          ContentionKind.ReverseDependency,
        );
      }
    }

    // ---- 3. Shared-contract risk (Req 22.3) --------------------------------
    // Two distinct changed paths whose contract fingerprints match (identical
    // public surface) share a contract. Group changed paths by fingerprint hash.
    const byFingerprint = new Map<
      string,
      { key: string; id: string; members: Map<string, MemberRef> }[]
    >();
    for (const contract of context.graph.contracts) {
      const key = normalizePathKey(contract.id, sensitivity);
      const members = membersByPathKey.get(key);
      if (members === undefined) {
        continue; // this contract's path is not being changed by anyone.
      }
      const bucket = byFingerprint.get(contract.fingerprint) ?? [];
      bucket.push({ key, id: contract.id, members });
      byFingerprint.set(contract.fingerprint, bucket);
    }

    for (const bucket of byFingerprint.values()) {
      if (bucket.length < 2) {
        continue; // need at least two distinct paths sharing the fingerprint.
      }
      for (const self of bucket) {
        const candidate = candidates.get(self.key);
        if (candidate === undefined) {
          continue;
        }
        for (const other of bucket) {
          if (other.key === self.key) {
            continue;
          }
          let linked = false;
          for (const [memberId, member] of other.members) {
            if (self.members.has(memberId)) {
              continue; // same member on both paths — not cross-member.
            }
            linked = true;
            addContributor(candidate, member, ContentionKind.SharedContract);
          }
          if (linked) {
            candidate.indirect = true;
            candidate.sharedContracts.add(other.id);
            candidate.sharedContracts.add(self.id);
          }
        }
      }
    }
  }

  // ---- 4. Classify each candidate into a RiskMapEntry (Req 24; design §10.1) -
  const entries: RiskMapEntry[] = [];
  for (const candidate of candidates.values()) {
    const mode = resolveMode(candidate.displayPath, context.rules);
    const contended = candidate.directContended;

    const riskLevel: RiskLevel =
      mode === "hard" && contended
        ? "hard"
        : mode === "coordination-required" && contended
          ? "coordination-required"
          : "soft";

    const contributors = [...candidate.contributors.values()]
      .map((c) => ({ member: c.member, kind: c.kind }))
      .sort(
        (a, b) =>
          a.member.memberId.localeCompare(b.member.memberId) ||
          a.member.deviceId.localeCompare(b.member.deviceId) ||
          a.kind.localeCompare(b.kind),
      );

    const explanationType: "direct" | "indirect" = contended
      ? "direct"
      : candidate.indirect
        ? "indirect"
        : "direct";

    const explanation: RiskMapEntry["explanation"] = { type: explanationType };
    if (candidate.edges.size > 0) {
      explanation.edges = [...candidate.edges.values()].sort(
        (a, b) =>
          a.from.localeCompare(b.from) ||
          a.to.localeCompare(b.to) ||
          a.kind.localeCompare(b.kind) ||
          a.confidence.localeCompare(b.confidence),
      );
    }
    if (candidate.sharedContracts.size > 0) {
      explanation.sharedContracts = [...candidate.sharedContracts].sort(
        (a, b) => a.localeCompare(b),
      );
    }

    entries.push({
      path: candidate.displayPath,
      riskLevel,
      contributors,
      explanation,
      acknowledgementRequired: riskLevel === "coordination-required",
    });
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}
