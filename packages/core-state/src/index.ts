/**
 * @cfls/core-state — the pure, dependency-free coordination engine:
 * revisions, locks, presence, intents, risk, sync, expiry, coalescing,
 * and the data-minimization filter. Primary property-based-testing target.
 *
 * Implemented incrementally across spec tasks 4.1–4.26.
 */

export const PACKAGE_NAME = "@cfls/core-state";

// ---- Session identity, canonical repo ID, path normalization (task 4.1; §9) ----
export { deriveRepoId } from "./repo-id";
export {
  normalizePath,
  pathMatchKey,
  normalizePathKey,
  defaultCaseSensitivity,
} from "./path";
export type { PlatformCaseSensitivity } from "./path";
export { sessionKey, buildSessionId } from "./session";

// ---- Monotonic Event_Revision assignment with restart resume (task 4.4; §4.5) ----
export { RevisionCounter } from "./revisions";
export type { PersistedRevision } from "./revisions";

// ---- Ingest gate: idempotency, replay, schema/permission checks (task 4.6; §4.4) ----
export { IngestGate, permitAll } from "./ingest";
export type {
  IngestResult,
  IngestGateOptions,
  PermissionCheck,
  PermissionDecision,
  Applier,
  PersistedAppliedEvent,
} from "./ingest";

// ---- Lock registry & presence registry (task 4.8; §10.3, §10.4) ----
export { LockRegistry } from "./locks";
export type {
  LockAcquisition,
  LockRelease,
  AcquireOutcome,
  ReleaseResult,
  LockReleaseError,
} from "./locks";
export { PresenceRegistry } from "./presence";
export type { PresenceReport } from "./presence";

// ---- Rules-precedence resolver (task 4.12; Req 15; §6) ----
export {
  resolveMode,
  parseRulesConfig,
  mostRestrictive,
  globMatch,
  isRiskLevel,
  ALL_SOFT_CONFIG,
} from "./rules";
export type {
  RepositoryRuleEntry,
  RepositoryRulesConfig,
  RulesConfigError,
  RulesConfigParseResult,
} from "./rules";
