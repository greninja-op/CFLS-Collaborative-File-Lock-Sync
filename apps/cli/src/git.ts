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
export type GitRunner = (
  args: readonly string[],
  cwd: string,
) => GitCommandResult;

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

// ===========================================================================
// Automatic git sync helpers (Model A: per-user branches) — design "autoSync".
//
// These are the building blocks the opt-in {@link module:git-sync} loop and the
// `cfls sync …` commands use. Every helper routes through the injectable
// {@link GitRunner} so they are unit-testable with mocked command output and
// never shell out in tests. They are deliberately non-destructive: the producer
// publishes with `git push <remote> HEAD:refs/heads/<prefix><member>` so the
// user's checked-out branch is NEVER switched or reset behind their back, and
// {@link mergeNoConflict} always `git merge --abort`s on conflict so the working
// tree is never left in a conflicted state.
// ===========================================================================

/** Sanitize a member name into a git-ref-safe segment (no spaces/odd chars). */
export function sanitizeMemberName(member: string): string {
  return member
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/\.+$/g, "");
}

/** Build the per-user publish branch name `"<prefix><member>"`, e.g. `cfls/alice`. */
export function userBranchName(branchPrefix: string, member: string): string {
  return `${branchPrefix}${sanitizeMemberName(member)}`;
}

/** `git rev-parse --abbrev-ref HEAD`, or `null` when unavailable. */
export function currentBranch(
  cwd: string,
  runner: GitRunner = defaultGitRunner,
): string | null {
  const res = runner(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  return res.ok && res.stdout !== "" ? res.stdout : null;
}

/**
 * A single porcelain-parsed working-tree change: the repo-relative `path` and
 * its two-character porcelain `status` (e.g. ` M`, `A `, `??`).
 */
export interface WorkingTreeChange {
  status: string;
  path: string;
}

/**
 * Parse `git status --porcelain=v1 -z` style output into changed paths. We call
 * git with the NUL-delimited `-z` form (stable, whitespace-safe) and split on
 * NUL. Renames (`R`/`C`) carry an extra NUL-delimited "from" field which we skip,
 * keeping the destination path. Ignored files are excluded by git itself because
 * we do NOT pass `--ignored`, so `.gitignore` is always respected.
 */
export function parsePorcelain(stdout: string): WorkingTreeChange[] {
  const parts = stdout.split("\0").filter((p) => p.length > 0);
  const changes: WorkingTreeChange[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i] as string;
    // Each entry is "XY <path>" where XY are the two status columns.
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    // Rename/copy entries are followed by a separate "from" path token; skip it.
    if (status.startsWith("R") || status.startsWith("C")) {
      i += 1;
    }
    if (path.length > 0) {
      changes.push({ status, path });
    }
  }
  return changes;
}

/**
 * List the working-tree changes (non-ignored) as parsed porcelain entries. Uses
 * `-z` for robust, whitespace-safe parsing. Returns `[]` on any git failure so
 * callers treat "can't tell" as "nothing to do" (safe no-op).
 */
export function workingTreeChanges(
  cwd: string,
  runner: GitRunner = defaultGitRunner,
): WorkingTreeChange[] {
  const res = runner(["status", "--porcelain=v1", "-z"], cwd);
  if (!res.ok) {
    return [];
  }
  return parsePorcelain(res.stdout);
}

/**
 * Stage the given repo-relative paths. NEVER uses `git add .` / `-A`: only the
 * explicitly-listed, known-changed paths are staged, and `.gitignore` still
 * applies (git refuses to add an ignored path unless forced, which we never do).
 * A no-op when `paths` is empty.
 */
export function stagePaths(
  paths: readonly string[],
  cwd: string,
  runner: GitRunner = defaultGitRunner,
): GitCommandResult {
  if (paths.length === 0) {
    return { ok: true, stdout: "" };
  }
  return runner(["add", "--", ...paths], cwd);
}

/** Commit the currently-staged changes with `message` (no `-a`, no `--amend`). */
export function commit(
  message: string,
  cwd: string,
  runner: GitRunner = defaultGitRunner,
): GitCommandResult {
  return runner(["commit", "-m", message], cwd);
}

/**
 * Publish the current HEAD to `<remote>/<branch>` WITHOUT switching the local
 * checkout, via `git push <remote> HEAD:refs/heads/<branch>`. This is a plain
 * (non-force) push: a non-fast-forward is rejected by git and surfaced as
 * `{ ok: false }` so the caller can notify without ever clobbering remote work.
 */
export function push(
  remote: string,
  branch: string,
  cwd: string,
  runner: GitRunner = defaultGitRunner,
): GitCommandResult {
  return runner(["push", remote, `HEAD:refs/heads/${branch}`], cwd);
}

/** `git fetch <remote> --prune` — refresh remote-tracking refs. */
export function fetch(
  remote: string,
  cwd: string,
  runner: GitRunner = defaultGitRunner,
): GitCommandResult {
  return runner(["fetch", "--prune", remote], cwd);
}

/** Ahead/behind counts of a branch relative to the current HEAD. */
export interface TrackingBranch {
  /** Remote-tracking ref short name, e.g. `origin/cfls/alice`. */
  ref: string;
  /** The `cfls/<member>` branch name (remote stripped). */
  branch: string;
  /** The `<member>` portion after the prefix. */
  member: string;
  /** Tip commit hash of the remote-tracking ref. */
  commit: string;
  /** Commits on this branch not on HEAD (how far HEAD is BEHIND it). */
  ahead: number;
  /** Commits on HEAD not on this branch (how far HEAD is AHEAD of it). */
  behind: number;
}

/**
 * Parse the output of `git for-each-ref --format=%(refname:short) %(objectname)`
 * over `refs/remotes/<remote>/<prefix>*` into `{ ref, branch, member, commit }`
 * rows. `ahead`/`behind` are filled in separately (per-ref rev-list counts).
 */
export function parseForEachRef(
  stdout: string,
  remote: string,
  branchPrefix: string,
): Array<Pick<TrackingBranch, "ref" | "branch" | "member" | "commit">> {
  const rows: Array<
    Pick<TrackingBranch, "ref" | "branch" | "member" | "commit">
  > = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    const sep = trimmed.lastIndexOf(" ");
    if (sep < 0) {
      continue;
    }
    const ref = trimmed.slice(0, sep);
    const commit = trimmed.slice(sep + 1);
    const remotePrefix = `${remote}/`;
    if (!ref.startsWith(remotePrefix)) {
      continue;
    }
    const branch = ref.slice(remotePrefix.length);
    if (!branch.startsWith(branchPrefix)) {
      continue;
    }
    rows.push({
      ref,
      branch,
      member: branch.slice(branchPrefix.length),
      commit,
    });
  }
  return rows;
}

/**
 * Parse `git rev-list --left-right --count <A>...<B>` output (two integers).
 * Returns `{ left, right }` where, for `HEAD...<ref>`, `left` = commits on HEAD
 * only (HEAD behind the ref by `right`), `right` = commits on the ref only.
 */
export function parseLeftRightCount(stdout: string): {
  left: number;
  right: number;
} {
  const match = stdout.trim().match(/^(\d+)\s+(\d+)$/);
  if (match === null) {
    return { left: 0, right: 0 };
  }
  return {
    left: Number.parseInt(match[1] as string, 10),
    right: Number.parseInt(match[2] as string, 10),
  };
}

/**
 * List the remote-tracking `<remote>/<prefix>*` branches with their ahead/behind
 * counts relative to the current HEAD. `ahead` = commits the teammate branch has
 * that HEAD lacks (i.e. new work to consume); `behind` = commits HEAD has that
 * the teammate branch lacks. The caller filters out the current user's own
 * publish branch. Returns `[]` on git failure.
 */
export function listTrackingBranches(
  remote: string,
  branchPrefix: string,
  cwd: string,
  runner: GitRunner = defaultGitRunner,
): TrackingBranch[] {
  const refs = runner(
    [
      "for-each-ref",
      "--format=%(refname:short) %(objectname)",
      `refs/remotes/${remote}/${branchPrefix}`,
    ],
    cwd,
  );
  if (!refs.ok) {
    return [];
  }
  const rows = parseForEachRef(refs.stdout, remote, branchPrefix);
  const out: TrackingBranch[] = [];
  for (const row of rows) {
    const counts = runner(
      ["rev-list", "--left-right", "--count", `HEAD...${row.ref}`],
      cwd,
    );
    const { left, right } = counts.ok
      ? parseLeftRightCount(counts.stdout)
      : { left: 0, right: 0 };
    out.push({ ...row, ahead: right, behind: left });
  }
  return out;
}

/** The result of an attempted conflict-free merge (never leaves a dirty tree). */
export interface MergeResult {
  /** True when the merge completed cleanly (fast-forward or conflict-free). */
  ok: boolean;
  /** True when the merge hit conflicts and was aborted. */
  conflicted: boolean;
  /** True when there was nothing to merge (already up to date). */
  alreadyUpToDate?: boolean;
}

/**
 * Enable git's "reuse recorded resolution" (rerere) for this repository, so once
 * a conflict is resolved by hand git remembers the resolution and re-applies it
 * automatically the next time the same conflict appears (design "autoSync";
 * conflict-avoidance). Idempotent and best-effort: a failure is reported as
 * `{ ok: false }` and never throws. Runs `git config rerere.enabled true`.
 */
export function enableRerere(
  cwd: string,
  runner: GitRunner = defaultGitRunner,
): GitCommandResult {
  return runner(["config", "rerere.enabled", "true"], cwd);
}

/**
 * List the currently-conflicted (unmerged) paths via
 * `git diff --name-only --diff-filter=U -z`. Returns repo-relative paths with
 * forward slashes (git's native form). Returns `[]` on any git failure. Safe to
 * call whether or not a merge is in progress (yields `[]` when nothing conflicts).
 */
export function listConflictedFiles(
  cwd: string,
  runner: GitRunner = defaultGitRunner,
): string[] {
  const res = runner(["diff", "--name-only", "--diff-filter=U", "-z"], cwd);
  if (!res.ok) {
    return [];
  }
  return res.stdout.split("\0").filter((p) => p.length > 0);
}

/**
 * The files a `<toRef>` brings in relative to `<fromRef>`, via
 * `git diff --name-only -z <fromRef>...<toRef>` (the `...` three-dot form uses
 * the merge base, so this is exactly "what would change if I merged toRef").
 * Returns repo-relative forward-slash paths, or `[]` on git failure.
 */
export function filesChangedBetween(
  fromRef: string,
  toRef: string,
  cwd: string,
  runner: GitRunner = defaultGitRunner,
): string[] {
  const res = runner(
    ["diff", "--name-only", "-z", `${fromRef}...${toRef}`],
    cwd,
  );
  if (!res.ok) {
    return [];
  }
  return res.stdout.split("\0").filter((p) => p.length > 0);
}

/** A merge outcome that also reports which files conflicted (feature: helper). */
export interface DetailedMergeResult extends MergeResult {
  /** Repo-relative paths that conflicted (empty on a clean merge). */
  conflictedFiles: string[];
}

/**
 * Like {@link mergeNoConflict}, but on conflict it CAPTURES the conflicted file
 * list (before aborting) so the caller can show the user exactly which files
 * clashed. Still non-destructive: it `git merge --abort`s on conflict so the
 * working tree is restored. Returns `{ ok, conflicted, alreadyUpToDate?,
 * conflictedFiles }`.
 */
export function mergeReportingConflicts(
  branch: string,
  cwd: string,
  runner: GitRunner = defaultGitRunner,
): DetailedMergeResult {
  const merge = runner(["merge", "--no-edit", branch], cwd);
  if (merge.ok) {
    const alreadyUpToDate = /already up to date/i.test(merge.stdout);
    return {
      ok: true,
      conflicted: false,
      alreadyUpToDate,
      conflictedFiles: [],
    };
  }
  const conflictedFiles = listConflictedFiles(cwd, runner);
  runner(["merge", "--abort"], cwd);
  return { ok: false, conflicted: true, conflictedFiles };
}

/**
 * Start a merge and DELIBERATELY leave conflict markers in place for interactive
 * resolution (used by `cfls sync merge <member> --resolve`). On a clean merge it
 * behaves like {@link mergeReportingConflicts}. On conflict it does NOT abort —
 * the conflicted files are left with `<<<<<<<`/`>>>>>>>` markers so the user can
 * resolve them (e.g. in VS Code's merge editor) and then `git commit`. The
 * conflicted file list is returned so the caller can open those files.
 */
export function mergeLeavingConflicts(
  branch: string,
  cwd: string,
  runner: GitRunner = defaultGitRunner,
): DetailedMergeResult {
  const merge = runner(["merge", "--no-edit", branch], cwd);
  if (merge.ok) {
    const alreadyUpToDate = /already up to date/i.test(merge.stdout);
    return {
      ok: true,
      conflicted: false,
      alreadyUpToDate,
      conflictedFiles: [],
    };
  }
  // Leave the in-progress merge as-is for manual resolution.
  const conflictedFiles = listConflictedFiles(cwd, runner);
  return { ok: false, conflicted: true, conflictedFiles };
}

/**
 * Attempt to merge `branch` (typically `<remote>/cfls/<member>`) into the current
 * branch, aborting on ANY conflict so the working tree is never left in a
 * conflicted state. Returns `{ ok: true }` on a clean merge (including
 * fast-forward / already-up-to-date) or `{ ok: false, conflicted: true }` after
 * running `git merge --abort`. Never force-pushes, never auto-resolves conflicts.
 */
export function mergeNoConflict(
  branch: string,
  cwd: string,
  runner: GitRunner = defaultGitRunner,
): MergeResult {
  const merge = runner(["merge", "--no-edit", branch], cwd);
  if (merge.ok) {
    const alreadyUpToDate = /already up to date/i.test(merge.stdout);
    return { ok: true, conflicted: false, alreadyUpToDate };
  }
  // Merge failed — most likely a conflict. Abort to restore a clean tree. The
  // abort is best-effort; either way we report the merge as conflicted.
  runner(["merge", "--abort"], cwd);
  return { ok: false, conflicted: true };
}
