/**
 * Repository_Session resolution for the CLI (Req 10.1, 10.6; design §9.4).
 *
 * Combines the git facts collected by {@link collectGitFacts} with the team id
 * and repository root to produce a canonical {@link SessionId}. The actual
 * precedence logic (git first, then the manual `.coordination/session.json`
 * fallback) is delegated to `@cfls/agent`'s already-tested {@link resolveSession}
 * so the CLI and the agent agree byte-for-byte on session identity.
 */

import { resolveSession, type ResolvedSession } from "@cfls/agent";
import type { SessionId } from "@cfls/protocol";

import { collectGitFacts, defaultGitRunner, type GitRunner } from "./git";

/** The default team id when none is configured (design §9.4). */
export const DEFAULT_TEAM_ID = "default-team";

/** Inputs for {@link resolveRepositorySession}. */
export interface ResolveRepositorySessionInput {
  /** Repository root (used to locate the manual fallback and as the git cwd). */
  repoRoot: string;
  /** The team id; defaults to {@link DEFAULT_TEAM_ID}. */
  teamId?: string;
  /**
   * Explicit remote URL override (`--repo <url>`). When supplied it takes
   * precedence over the discovered `origin` remote.
   */
  remoteUrlOverride?: string;
  /** Injectable git runner (tests). */
  gitRunner?: GitRunner;
}

/**
 * Resolve the canonical {@link SessionId} for a repository (Req 10.1, 10.6).
 * Prefers git metadata (remote → `repoId`, branch, HEAD → `baseRevision`); when
 * git is unavailable it falls back to `.coordination/session.json` and throws a
 * clear error if neither source exists.
 */
export function resolveRepositorySession(
  input: ResolveRepositorySessionInput,
): ResolvedSession {
  const teamId = input.teamId ?? DEFAULT_TEAM_ID;
  const facts = collectGitFacts(
    input.repoRoot,
    input.gitRunner ?? defaultGitRunner,
  );
  const remoteUrl = input.remoteUrlOverride ?? facts.remoteUrl ?? undefined;

  return resolveSession({
    teamId,
    repoRoot: input.repoRoot,
    ...(remoteUrl !== undefined ? { remoteUrl } : {}),
    ...(facts.branch !== null ? { branch: facts.branch } : {}),
    baseRevision: facts.baseRevision,
  });
}

/** A short, human-readable one-line description of a session (no secrets). */
export function describeSession(session: SessionId): string {
  const base =
    session.baseRevision === null
      ? "(no base revision)"
      : session.baseRevision.slice(0, 10);
  return `repo=${session.repoId} team=${session.teamId} branch=${session.branch} base=${base}`;
}
