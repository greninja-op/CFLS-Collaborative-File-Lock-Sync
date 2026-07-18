/**
 * The pluggable `LanguageAnalyzer` interface (design §7.7).
 *
 * `analyzerVersion` is recorded in `Repository_Snapshot_Metadata`. The
 * TypeScript/JS import-graph analyzer ships first behind this interface so
 * other languages can be added later without touching the host or agent.
 *
 * Metadata-only guarantee (Req 19.2, 29; design §7.2): an analyzer extracts
 * import specifiers, manifest fields, and fingerprints/hashes only. It never
 * emits file bodies, comments, string literals beyond import specifiers,
 * secrets, or absolute paths.
 */

import type {
  ModuleDependencyMetadata,
  PublicContractFingerprint,
} from "@cfls/protocol";

/**
 * A single repository-relative source file handed to an analyzer.
 *
 * `path` is repository-relative and forward-slash normalized. `content` is the
 * in-memory text the analyzer scans for import specifiers only — it is never
 * retained, hashed wholesale, or transmitted.
 */
export interface RepoRelativeFile {
  /** Repository-relative, forward-slash-normalized path (e.g. `src/api.ts`). */
  readonly path: string;
  /** File text, scanned for import specifiers only; never emitted. */
  readonly content: string;
}

/** The metadata-only result of analyzing a set of files (design §7.7). */
export interface AnalyzeResult {
  /** Category 3 — per-source-file directed dependency edges. */
  readonly modules: ModuleDependencyMetadata[];
  /** Category 4 — hashed public-contract fingerprints (added in task 5.2). */
  readonly contracts: PublicContractFingerprint[];
}

/**
 * A pluggable, metadata-only dependency analyzer for one language family.
 *
 * Implementations MUST derive dependency edges from import specifiers /
 * manifests only, never from file bodies (design §7.2, §7.7).
 */
export interface LanguageAnalyzer {
  /** Human-readable language family identifier (e.g. `typescript-javascript`). */
  readonly language: string;
  /** Analyzer version recorded in `Repository_Snapshot_Metadata` (design §7.7). */
  readonly version: string;
  /** Produce metadata-only dependency edges for the supported files in `files`. */
  analyze(files: RepoRelativeFile[]): AnalyzeResult;
  /** Whether this analyzer can extract dependencies from the given path. */
  supports(path: string): boolean;
}
