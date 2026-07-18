/**
 * @cfls/dependency-analyzer — pluggable, metadata-only dependency analysis
 * (TS/JS first) that feeds indirect-risk detection. Never reads file bodies.
 *
 * Task 5.1 landed the `LanguageAnalyzer` interface (design §7.7) and the
 * first-party TypeScript/JavaScript import-graph analyzer (design §7.5).
 * Task 5.2 adds manifest metadata (`Package_Dependency_Metadata`), public
 * contract fingerprints (hashes only), and the always-excluded list
 * (design §7.1, §7.6). Snapshot/delta computation follows in task 5.3.
 */

export const PACKAGE_NAME = "@cfls/dependency-analyzer";

export type {
  LanguageAnalyzer,
  RepoRelativeFile,
  AnalyzeResult,
} from "./language-analyzer";

export {
  TsJsImportAnalyzer,
  tsJsAnalyzer,
  DYNAMIC_TARGET,
} from "./ts-js-analyzer";

// ---- Always-excluded list (design §7.6; Req 19.7, 29.2) ----
export {
  EXCLUDED_DIRECTORIES,
  isExcludedPath,
  filterIncluded,
} from "./exclusion";

// ---- Category 2 — package/manifest dependency metadata (design §7.1) ----
export { extractPackageMetadata } from "./manifest";

// ---- Category 4 — public-contract fingerprints, hashes only (design §7.1) ----
export {
  extractContractFingerprints,
  extractTsJsContracts,
  extractExportedNames,
} from "./contracts";
