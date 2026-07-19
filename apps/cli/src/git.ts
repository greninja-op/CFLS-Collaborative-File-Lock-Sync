/**
 * Git metadata discovery for the `cfls` CLI (design §9.4; Req 10.1, 10.6).
 *
 * The CLI derives a `Repository_Session` from the git repository in the current
 * working directory: the `origin` remote URL (→ canonical `repoId`), the current
 * branch (`Branch_Context`), and `HEAD` (`Base_Revision`). All git invocations go
 * through an injectable {@link GitRunner} so the fact-collection logic is unit
 * testable with mocked command output and never actually shells out in tests.
 */

import { execFileSync } from "node:child_process";

/** The outcome of running a single git subcommand. */
export interface GitCommandResult {
  /** True when git exited 0. */
  ok: boolean;
  /** Trimmed stdout (empty string on failure). */
  stdout: string;
}

/** Runs a git subcommand (args after `git`) in a working directory. */
export type GitRunner = (args: readonly string[], cwd: string) => GitCommandResult;

/** The three git facts the CLI cares about; each is `null` when unavailable. */
export interface GitFacts {
  /** `git remote get-url origin`, or `null` when there is no origin/remote. */
  remoteUrl: string | null;
  /** `git rev-parse --abbrev-ref HEAD`, or `null` when unavailable. */
  branch: string | null;
  /** `git rev-parse HEAD`, or `null` when there are no commits yet. */
  baseRevision: string | null;
}

/**
 * The default {@link GitRunner}: invokes the real `git` binary. Never throws —
 * a non-zero exit or a missing git binary is reported as `{ ok: false }` so the
 * caller can fall back to the manual session config (Req 10.6).
 */
export const defaultGitRunner: GitRunner = (args, cwd) => {
  try {
    const stdout = execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { ok: true, stdout: stdout.trim() };
  } catch {
    return { ok: false, stdout: "" };
  }
};

/**
 * Collect the git facts for `cwd` using `runner` (Req 10.1). A failed command
 * yields `null` for that fact rather than throwing, so a directory that is not a
 * git repository simply returns all-`null` and the caller falls back to the
 * manual `.coordination/session.json` (Req 10.6).
 */
export function collectGitFacts(
  cwd: string,
  runner: GitRunner = defaultGitRunner,
): GitFacts {
  const remote = runner(["remote", "get-url", "origin"], cwd);
  const branch = runner(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  const head = runner(["rev-parse", "HEAD"], cwd);
  return {
    remoteUrl: remote.ok && remote.stdout !== "" ? remote.stdout : null,
    branch: branch.ok && branch.stdout !== "" ? branch.stdout : null,
    baseRevision: head.ok && head.stdout !== "" ? head.stdout : null,
  };
}
