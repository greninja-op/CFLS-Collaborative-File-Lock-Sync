/**
 * Snapshot-vs-delta decision and Change_Delta_Metadata computation
 * (design §7.3, §7.4; Req 19.3, 19.4, 19.5, 20.1).
 *
 * On first authorization an agent builds a full graph and sends a
 * `dep.snapshot` **only if** the host lacks a graph for the same
 * `(repoId, teamId, branch, baseRevision)` identity (Req 19.3). Once the host
 * holds a graph for that identity, agents send incremental
 * `dep.delta` (Change_Delta_Metadata) for subsequent import/manifest/lockfile/
 * contract changes (Req 19.4) and never re-upload a full graph the host already
 * holds at the same branch/base revision (Req 19.5) — decided here by comparing
 * snapshot identity plus `graphVersion`.
 */

import type {
  ChangeDeltaMetadata,
  ChangedDependencyEdge,
  DependencyEdge,
  DependencyGraph,
  PackageDependencyMetadata,
  PublicContractFingerprint,
  SessionId,
} from "@cfls/protocol";

// ---------------------------------------------------------------------------
// Snapshot identity — a graph is stored per (repoId, teamId, branch, base).
// ---------------------------------------------------------------------------

/**
 * A stable string key for the storage identity of a graph (design §7.4):
 * `repoId | teamId | branch | baseRevision`. Two graphs with the same key are
 * stored under the same session/branch/base and must never be combined with a
 * graph having a different key when assessing risk (Req 20.3).
 */
export function snapshotIdentityKey(session: SessionId): string {
  return [
    session.repoId,
    session.teamId,
    session.branch,
    session.baseRevision ?? "",
  ].join("\u0000");
}

/** Whether two sessions share the same graph storage identity (Req 20.1). */
export function sameSnapshotIdentity(a: SessionId, b: SessionId): boolean {
  return snapshotIdentityKey(a) === snapshotIdentityKey(b);
}

// ---------------------------------------------------------------------------
// Delta computation.
// ---------------------------------------------------------------------------

function edgeKey(edge: DependencyEdge): string {
  return [edge.from, edge.to, edge.kind, edge.confidence].join("\u0000");
}

function collectEdges(graph: DependencyGraph): Map<string, DependencyEdge> {
  const edges = new Map<string, DependencyEdge>();
  for (const mod of graph.modules) {
    for (const edge of mod.edges) edges.set(edgeKey(edge), edge);
  }
  return edges;
}

function compareChangedEdges(
  a: ChangedDependencyEdge,
  b: ChangedDependencyEdge,
): number {
  return (
    a.from.localeCompare(b.from) ||
    a.to.localeCompare(b.to) ||
    a.kind.localeCompare(b.kind) ||
    a.confidence.localeCompare(b.confidence) ||
    a.op.localeCompare(b.op)
  );
}

/** All (manifestPath, scope) entries for a graph, keyed for comparison. */
function collectManifests(
  graph: DependencyGraph,
): Map<string, PackageDependencyMetadata> {
  const manifests = new Map<string, PackageDependencyMetadata>();
  for (const pkg of graph.packages) {
    manifests.set(`${pkg.manifestPath}\u0000${pkg.scope}`, pkg);
  }
  return manifests;
}

function manifestEntryEquals(
  a: PackageDependencyMetadata,
  b: PackageDependencyMetadata,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function collectContracts(
  graph: DependencyGraph,
): Map<string, PublicContractFingerprint> {
  const contracts = new Map<string, PublicContractFingerprint>();
  for (const contract of graph.contracts) contracts.set(contract.id, contract);
  return contracts;
}

/**
 * Compute the {@link ChangeDeltaMetadata} that transforms `previous` into
 * `next` (Req 19.4). The result carries:
 *
 *   - `changedEdges`: edges added (`op: "add"`) or removed (`op: "remove"`).
 *   - `changedManifests`: manifest paths whose declared dependency metadata was
 *     added, removed, or modified.
 *   - `changedLockfileHash`: the new hash of the first (sorted) manifest whose
 *     lockfile hash changed, if any.
 *   - `changedContracts`: contracts added or re-fingerprinted; a removed
 *     contract is signaled by an entry whose `fingerprint` is the empty string.
 *
 * All arrays are returned in a deterministic order so the delta is stable
 * regardless of input ordering.
 */
export function computeDelta(
  previous: DependencyGraph,
  next: DependencyGraph,
): ChangeDeltaMetadata {
  // ---- Edges ----
  const prevEdges = collectEdges(previous);
  const nextEdges = collectEdges(next);
  const changedEdges: ChangedDependencyEdge[] = [];
  for (const [key, edge] of nextEdges) {
    if (!prevEdges.has(key)) changedEdges.push({ ...edge, op: "add" });
  }
  for (const [key, edge] of prevEdges) {
    if (!nextEdges.has(key)) changedEdges.push({ ...edge, op: "remove" });
  }
  changedEdges.sort(compareChangedEdges);

  // ---- Manifests + lockfile hash ----
  const prevManifests = collectManifests(previous);
  const nextManifests = collectManifests(next);
  const changedManifestPaths = new Set<string>();
  const lockfileChanges: { path: string; hash: string }[] = [];

  const manifestKeys = new Set([
    ...prevManifests.keys(),
    ...nextManifests.keys(),
  ]);
  for (const key of manifestKeys) {
    const before = prevManifests.get(key);
    const after = nextManifests.get(key);
    if (before && after && manifestEntryEquals(before, after)) continue;
    const path = (after ?? before)?.manifestPath;
    if (path !== undefined) changedManifestPaths.add(path);
    if ((before?.lockfileHash ?? "") !== (after?.lockfileHash ?? "")) {
      const path2 = (after ?? before)?.manifestPath;
      if (path2 !== undefined) {
        lockfileChanges.push({ path: path2, hash: after?.lockfileHash ?? "" });
      }
    }
  }
  const changedManifests = [...changedManifestPaths].sort((a, b) =>
    a.localeCompare(b),
  );
  lockfileChanges.sort((a, b) => a.path.localeCompare(b.path));

  // ---- Contracts ----
  const prevContracts = collectContracts(previous);
  const nextContracts = collectContracts(next);
  const changedContracts: PublicContractFingerprint[] = [];
  for (const [id, contract] of nextContracts) {
    const before = prevContracts.get(id);
    if (!before || before.fingerprint !== contract.fingerprint) {
      changedContracts.push(contract);
    }
  }
  for (const [id, contract] of prevContracts) {
    if (!nextContracts.has(id)) {
      // Removed contract: empty fingerprint signals deletion.
      changedContracts.push({ id, kind: contract.kind, fingerprint: "" });
    }
  }
  changedContracts.sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id),
  );

  const delta: ChangeDeltaMetadata = {
    changedEdges,
    changedManifests,
    changedContracts,
  };
  const firstLockfileChange = lockfileChanges[0];
  if (firstLockfileChange) {
    delta.changedLockfileHash = firstLockfileChange.hash;
  }
  return delta;
}

/** Whether a delta carries no changes at all. */
export function isEmptyDelta(delta: ChangeDeltaMetadata): boolean {
  return (
    delta.changedEdges.length === 0 &&
    delta.changedManifests.length === 0 &&
    delta.changedContracts.length === 0 &&
    delta.changedLockfileHash === undefined
  );
}

// ---------------------------------------------------------------------------
// Upload decision — snapshot vs delta vs nothing.
// ---------------------------------------------------------------------------

/** What the host currently holds for a graph storage identity. */
export interface HostGraphView {
  /** The session identity of the graph the host holds. */
  readonly sessionId: SessionId;
  /** The graph version the host holds for that identity. */
  readonly graphVersion: number;
}

/** The decision produced by {@link decideUpload}. */
export type UploadDecision =
  | { readonly kind: "snapshot"; readonly graph: DependencyGraph }
  | { readonly kind: "delta"; readonly delta: ChangeDeltaMetadata }
  | { readonly kind: "none" };

/** Inputs to the snapshot-vs-delta decision. */
export interface UploadDecisionInput {
  /** The freshly built local graph the agent would upload. */
  readonly localGraph: DependencyGraph;
  /**
   * What the host currently holds for this graph identity, or `null`/`undefined`
   * when the host holds nothing for it.
   */
  readonly hostGraph?: HostGraphView | null;
  /**
   * The previous local graph (as last reflected to the host) for the same
   * identity, used to compute an incremental delta. When absent and the host is
   * behind, a full snapshot is sent as a fallback.
   */
  readonly previousLocalGraph?: DependencyGraph | null;
}

/**
 * Decide whether to upload a full `dep.snapshot`, an incremental `dep.delta`,
 * or nothing at all (design §7.3; Req 19.3, 19.4, 19.5).
 *
 *   - Host holds nothing for this identity → `snapshot` (Req 19.3).
 *   - Host already holds the same-or-newer `graphVersion` → `none`; agents do
 *     not re-upload a graph the host already holds (Req 19.5).
 *   - Host is behind and a previous local graph is available → `delta`
 *     (Req 19.4); an empty delta collapses to `none`.
 *   - Host is behind with no previous local graph → `snapshot` (fallback).
 */
export function decideUpload(input: UploadDecisionInput): UploadDecision {
  const { localGraph, hostGraph, previousLocalGraph } = input;

  // Host holds nothing for this (repoId, teamId, branch, baseRevision).
  if (
    !hostGraph ||
    !sameSnapshotIdentity(hostGraph.sessionId, localGraph.snapshot.sessionId)
  ) {
    return { kind: "snapshot", graph: localGraph };
  }

  // Host already holds this graph version (or newer): do not re-upload.
  if (hostGraph.graphVersion >= localGraph.snapshot.graphVersion) {
    return { kind: "none" };
  }

  // Host is behind: prefer an incremental delta when we can compute one.
  if (previousLocalGraph) {
    const delta = computeDelta(previousLocalGraph, localGraph);
    return isEmptyDelta(delta) ? { kind: "none" } : { kind: "delta", delta };
  }

  // Behind, but no baseline to diff against: fall back to a full snapshot.
  return { kind: "snapshot", graph: localGraph };
}
