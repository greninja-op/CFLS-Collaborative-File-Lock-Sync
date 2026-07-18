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
