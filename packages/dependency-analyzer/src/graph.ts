/**
 * Full Dependency_Graph construction and deterministic serialization
 * (design §7.1, §7.3, §7.4; Req 19.3, 20.4).
 *
 * `buildDependencyGraph` assembles the four *stored* metadata categories of a
 * {@link DependencyGraph} from an in-memory set of repository-relative files:
 *
 *   1. Repository_Snapshot_Metadata — session id + graph/analyzer versions.
 *   2. Package_Dependency_Metadata  — from `package.json` manifests.
 *   3. Module_Dependency_Metadata   — directed import edges (metadata only).
 *   4. Public_Contract_Fingerprints — hashes only, never contents.
 *
 * The fifth category, Change_Delta_Metadata, is produced separately by
 * {@link module:delta} once a prior graph exists.
 *
 * Serialization is *canonical*: arrays are sorted into a stable order and
 * object keys are emitted in sorted order, so a serialize → deserialize
 * round-trip yields an equivalent graph regardless of input ordering
 * (Req 20.4, Property 6). The exclusion list (design §7.6) is applied before
 * any analysis so `node_modules`, build outputs, caches, secrets, etc. never
 * enter the graph (Req 19.7).
 */

import type {
  ChangeDeltaMetadata,
  DependencyGraph,
  ModuleDependencyMetadata,
  PackageDependencyMetadata,
  PublicContractFingerprint,
  SessionId,
} from "@cfls/protocol";

import { extractContractFingerprints } from "./contracts";
import { filterIncluded } from "./exclusion";
import type { LanguageAnalyzer, RepoRelativeFile } from "./language-analyzer";
import { extractPackageMetadata } from "./manifest";
import { tsJsAnalyzer } from "./ts-js-analyzer";

/** The graph version assigned to the first graph built for a session. */
export const INITIAL_GRAPH_VERSION = 1;

/** Options controlling {@link buildDependencyGraph}. */
export interface BuildGraphOptions {
  /** The language analyzer to use for module edges (defaults to TS/JS). */
  readonly analyzer?: LanguageAnalyzer;
  /** The graph version to record (defaults to {@link INITIAL_GRAPH_VERSION}). */
  readonly graphVersion?: number;
}

/**
 * Build a full, metadata-only {@link DependencyGraph} for `sessionId` from the
 * given files. Excluded paths (design §7.6) are dropped before analysis so no
 * package store, build output, cache, or secret is ever reflected in the graph.
 */
export function buildDependencyGraph(
  sessionId: SessionId,
  files: RepoRelativeFile[],
  options: BuildGraphOptions = {},
): DependencyGraph {
  const analyzer = options.analyzer ?? tsJsAnalyzer;
  const graphVersion = options.graphVersion ?? INITIAL_GRAPH_VERSION;

  // Apply the always-excluded list once, up front, so every downstream
  // extractor operates on the same included view (design §7.6; Req 19.7).
  const included = filterIncluded(files);

  const modules = analyzer.analyze(included).modules;
  const packages = extractPackageMetadata(included);
  const contracts = extractContractFingerprints(included);

  return normalizeGraph({
    snapshot: {
      sessionId,
      graphVersion,
      analyzerVersion: analyzer.version,
    },
    packages,
    modules,
    contracts,
  });
}

// ---------------------------------------------------------------------------
// Normalization — a stable, canonical ordering for every array/record so two
// graphs describing the same set compare and serialize identically.
// ---------------------------------------------------------------------------

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sort a `name → range` record into a fresh object with sorted keys. */
function sortRecord(record: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(record).sort(compareStrings)) {
    out[key] = record[key] as string;
  }
  return out;
}

function normalizePackage(
  pkg: PackageDependencyMetadata,
): PackageDependencyMetadata {
  return {
    manifestPath: pkg.manifestPath,
    packageManager: pkg.packageManager,
    directDependencyNames: [...pkg.directDependencyNames].sort(compareStrings),
    declaredVersionRanges: sortRecord(pkg.declaredVersionRanges),
    scope: pkg.scope,
    lockfileHash: pkg.lockfileHash,
  };
}

function comparePackages(
  a: PackageDependencyMetadata,
  b: PackageDependencyMetadata,
): number {
  return (
    compareStrings(a.manifestPath, b.manifestPath) ||
    compareStrings(a.scope, b.scope)
  );
}

function normalizeModule(
  mod: ModuleDependencyMetadata,
): ModuleDependencyMetadata {
  const edges = [...mod.edges].sort(
    (a, b) =>
      compareStrings(a.from, b.from) ||
      compareStrings(a.to, b.to) ||
      compareStrings(a.kind, b.kind) ||
      compareStrings(a.confidence, b.confidence),
  );
  return { sourceFile: mod.sourceFile, edges };
}

function compareContracts(
  a: PublicContractFingerprint,
  b: PublicContractFingerprint,
): number {
  return compareStrings(a.kind, b.kind) || compareStrings(a.id, b.id);
}

/**
 * Return an equivalent graph with every array in a canonical order and every
 * record's keys sorted. Idempotent: `normalizeGraph(normalizeGraph(g))` equals
 * `normalizeGraph(g)`.
 */
export function normalizeGraph(graph: DependencyGraph): DependencyGraph {
  return {
    snapshot: {
      sessionId: graph.snapshot.sessionId,
      graphVersion: graph.snapshot.graphVersion,
      analyzerVersion: graph.snapshot.analyzerVersion,
    },
    packages: graph.packages.map(normalizePackage).sort(comparePackages),
    modules: graph.modules
      .map(normalizeModule)
      .sort((a, b) => compareStrings(a.sourceFile, b.sourceFile)),
    contracts: [...graph.contracts].sort(compareContracts),
  };
}

// ---------------------------------------------------------------------------
// Canonical JSON — recursive key sorting so object key order never affects the
// serialized form (arrays are already normalized above).
// ---------------------------------------------------------------------------

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort(compareStrings)) {
      out[key] = canonicalize(record[key]);
    }
    return out;
  }
  return value;
}

/**
 * Serialize a {@link DependencyGraph} to a canonical JSON string. Two graphs
 * describing the same set of metadata serialize to byte-identical strings, and
 * {@link deserializeGraph} recovers an equivalent graph (Req 20.4).
 */
export function serializeGraph(graph: DependencyGraph): string {
  return JSON.stringify(canonicalize(normalizeGraph(graph)));
}

/** Parse a graph produced by {@link serializeGraph} back into a graph. */
export function deserializeGraph(json: string): DependencyGraph {
  return normalizeGraph(JSON.parse(json) as DependencyGraph);
}

/** Serialize a {@link ChangeDeltaMetadata} to a canonical JSON string. */
export function serializeDelta(delta: ChangeDeltaMetadata): string {
  return JSON.stringify(canonicalize(delta));
}

/** Parse a delta produced by {@link serializeDelta}. */
export function deserializeDelta(json: string): ChangeDeltaMetadata {
  return JSON.parse(json) as ChangeDeltaMetadata;
}
