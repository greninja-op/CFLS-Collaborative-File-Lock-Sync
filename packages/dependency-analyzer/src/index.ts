/**
 * @cfls/dependency-analyzer — pluggable, metadata-only dependency analysis
 * (TS/JS first) that feeds indirect-risk detection. Never reads file bodies.
 *
 * Task 5.1 lands the `LanguageAnalyzer` interface (design §7.7) and the
 * first-party TypeScript/JavaScript import-graph analyzer (design §7.5).
 * Manifest metadata, contract fingerprints, exclusion list, and snapshot/delta
 * computation follow in tasks 5.2–5.3.
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
