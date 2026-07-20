/**
 * Opt-in automatic git sync loop (Model A: per-user branches) for `cfls agent`.
 *
 * This layers on top of the metadata-only coordination: git remains the thing
 * that moves file bytes. When (and ONLY when) the team's committed
 * `.coordination/config.json` sets `autoSync.enabled = true`, `cfls agent`
 * starts a background loop that:
 *
 *   - PRODUCER (every `commitIntervalSec`): if the working tree has non-ignored
 *     changes, stages exactly those known-changed paths (never `git add .`),
 *     commits them, and publishes to `cfls/<member>` via
 *     `git push <remote> HEAD:refs/heads/cfls/<member>` — WITHOUT switching the
 *     user's checked-out branch. A rejected (non-fast-forward) or unauthenticated
 *     push logs a concise, secret-free notice and the loop continues.
 *   - CONSUMER (every `fetchIntervalSec`): fetches the remote and, for each OTHER
 *     `cfls/*` branch that advanced since the last cycle, notifies
 *     "<member> published <n> commit(s)". When `autoMerge` is enabled it attempts
 *     a conflict-free {@link mergeNoConflict}; on conflict it aborts and reports
 *     "manual merge needed" — it NEVER auto-resolves conflicts.
 *
 * Everything here is a strict no-op when `autoSync.enabled` is false (the
 * default), so default `cfls agent` behavior is unchanged. The loop is fully
 * cancellable, integrates with the existing SIGINT/shutdown path, and never
 * throws out of a timer.
 *
 * The pure decision functions ({@link decideProducer}, {@link decideConsumer})
 * are exported and unit-tested with a mocked {@link GitRunner}; the loop itself
 * only schedules them and formats notices.
 */

import type { AutoSyncConfig } from "./config-files";
import {
  commit,
  fetch,
  filesChangedBetween,
  listTrackingBranches,
  mergeNoConflict,
  push,
  stagePaths,
  userBranchName,
  workingTreeChanges,
  type GitRunner,
  type TrackingBranch,
} from "./git";
import { defaultGitRunner } from "./git";

/** Normalize a repo-relative path for cross-platform comparison (slashes, case). */
function normalizeForCompare(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

/**
 * Intersect the files an incoming teammate branch would change with the set of
 * paths OTHER teammates are actively editing/holding right now (from the live
 * coordination view). Returns the ORIGINAL `incomingFiles` entries that collide,
 * so the caller can warn "this merge touches a file someone is editing" before
 * doing anything. Comparison is slash- and case-insensitive (Windows-friendly).
 */
export function detectLockCollisions(
  incomingFiles: readonly string[],
  heldByOthers: ReadonlySet<string>,
): string[] {
  if (heldByOthers.size === 0 || incomingFiles.length === 0) {
    return [];
  }
  const held = new Set([...heldByOthers].map(normalizeForCompare));
  return incomingFiles.filter((f) => held.has(normalizeForCompare(f)));
}

/** A single-line notice emitted by the sync loop (secret-free, human-readable). */
export type SyncNotice = string;

/** Build the producer commit message: `"cfls: <member> sync <n> file(s)"`. */
export function buildCommitMessage(member: string, fileCount: number): string {
  const noun = fileCount === 1 ? "file" : "files";
  return `cfls: ${member} sync ${fileCount} ${noun}`;
}

/** The outcome of one producer cycle. */
export interface ProducerResult {
  /** What the producer did this cycle. */
  action: "skipped" | "pushed" | "commit-failed" | "push-failed";
  /** Number of changed paths considered (0 when skipped for nothing-to-commit). */
  changedCount: number;
  /** Human-readable notices to log (secret-free). */
  notices: SyncNotice[];
}

/** Dependencies for a producer/consumer cycle (all git access is injectable). */
export interface SyncDeps {
  /** Repository root / git cwd. */
  cwd: string;
  /** The effective autoSync config (already defaulted). */
  config: AutoSyncConfig;
  /** This teammate's member name (→ `cfls/<member>`). */
  member: string;
  /** Injectable git runner (mocked in tests). */
  runner: GitRunner;
  /**
   * OPTIONAL snapshot of repo-relative paths OTHER teammates are actively
   * editing/holding right now (from the live coordination view). When provided,
   * the consumer cross-checks each incoming teammate branch against it and warns
   * before touching a file someone is mid-edit on; with `autoMerge` on it also
   * DEFERS the auto-merge for those branches so it never clobbers live work.
   * Absent ⇒ the pre-warning is skipped (unchanged behavior).
   */
  heldPathsByOthers?: ReadonlySet<string>;
}

/**
 * Run ONE producer cycle: stage changed paths, commit, and publish to
 * `cfls/<member>`. A clean skip (`action: "skipped"`) happens when the working
 * tree has no non-ignored changes. Commit/push failures are reported (not
 * thrown) so the loop can continue. Never uses `git add .`; only the known
 * changed paths are staged so `.gitignore` and untracked-but-ignored files are
 * always respected.
 */
export function decideProducer(deps: SyncDeps): ProducerResult {
  const { cwd, config, member, runner } = deps;
  const changes = workingTreeChanges(cwd, runner);
  if (changes.length === 0) {
    return { action: "skipped", changedCount: 0, notices: [] };
  }

  const paths = changes.map((c) => c.path);
  const staged = stagePaths(paths, cwd, runner);
  if (!staged.ok) {
    return {
      action: "commit-failed",
      changedCount: paths.length,
      notices: ["auto-sync: could not stage changes; will retry next cycle."],
    };
  }

  const message = buildCommitMessage(member, paths.length);
  const committed = commit(message, cwd, runner);
  if (!committed.ok) {
    return {
      action: "commit-failed",
      changedCount: paths.length,
      notices: ["auto-sync: nothing committed (no staged changes); skipping."],
    };
  }

  const branch = userBranchName(config.branchPrefix, member);
  const pushed = push(config.remote, branch, cwd, runner);
  if (!pushed.ok) {
    return {
      action: "push-failed",
      changedCount: paths.length,
      notices: [
        `auto-sync: committed ${paths.length} file(s) but push to ${branch} was rejected ` +
          "(auth or non-fast-forward). Fetch/merge or check credentials, then it retries.",
      ],
    };
  }

  return {
    action: "pushed",
    changedCount: paths.length,
    notices: [`auto-sync: published ${paths.length} file(s) to ${branch}.`],
  };
}

/** A teammate branch that advanced since the previous consumer cycle. */
export interface AdvancedBranch {
  member: string;
  branch: string;
  ref: string;
  /** New commits the teammate branch has that our HEAD lacks. */
  ahead: number;
  /** Whether an autoMerge was attempted and applied cleanly. */
  merged?: boolean;
  /** Whether an autoMerge was attempted but aborted due to conflicts. */
  conflicted?: boolean;
  /**
   * Incoming files that collide with a path a teammate is editing right now.
   * When non-empty, an otherwise-eligible autoMerge is DEFERRED (not attempted)
   * so live work is never overwritten; the user is told to review + merge by hand.
   */
  lockCollisions?: string[];
}

/** The outcome of one consumer cycle. */
export interface ConsumerResult {
  /** Branches that advanced (relative to `previous` tips) this cycle. */
  advanced: AdvancedBranch[];
  /** The refreshed tip map to feed into the next cycle. */
  tips: Map<string, string>;
  /** Human-readable notices to log (secret-free). */
  notices: SyncNotice[];
  /** True when the fetch failed (loop should just retry next cycle). */
  fetchFailed: boolean;
}

/**
 * Run ONE consumer cycle: fetch, then detect which OTHER `cfls/*` branches
 * advanced since `previous` (a map of branch → last-seen tip commit). For each
 * advanced branch it emits a "<member> published <n> commit(s)" notice; when
 * `autoMerge` is enabled AND the teammate branch is strictly ahead it attempts a
 * conflict-free {@link mergeNoConflict} into the current branch, reporting
 * "applied" vs "manual merge needed". The current user's own `cfls/<member>`
 * branch is always excluded (you never consume your own publish branch).
 */
export function decideConsumer(
  deps: SyncDeps,
  previous: ReadonlyMap<string, string>,
): ConsumerResult {
  const { cwd, config, member, runner } = deps;
  const fetched = fetch(config.remote, cwd, runner);
  if (!fetched.ok) {
    return {
      advanced: [],
      tips: new Map(previous),
      notices: ["auto-sync: fetch failed; will retry next cycle."],
      fetchFailed: true,
    };
  }

  const ownBranch = userBranchName(config.branchPrefix, member);
  const branches = listTrackingBranches(
    config.remote,
    config.branchPrefix,
    cwd,
    runner,
  ).filter((b: TrackingBranch) => b.branch !== ownBranch);

  const tips = new Map<string, string>();
  const advanced: AdvancedBranch[] = [];
  const notices: SyncNotice[] = [];

  for (const b of branches) {
    tips.set(b.branch, b.commit);
    const seen = previous.get(b.branch);
    // "Advanced" = a new tip we haven't seen before that has commits we lack.
    if (seen === b.commit || b.ahead === 0) {
      continue;
    }
    const entry: AdvancedBranch = {
      member: b.member,
      branch: b.branch,
      ref: b.ref,
      ahead: b.ahead,
    };
    const noun = b.ahead === 1 ? "commit" : "commits";
    notices.push(`${b.member} published ${b.ahead} ${noun} (${b.branch}).`);

    // Pre-warning (coordination-aware): if this branch would touch a file a
    // teammate is editing RIGHT NOW, surface it before doing anything.
    let collisions: string[] = [];
    if (
      deps.heldPathsByOthers !== undefined &&
      deps.heldPathsByOthers.size > 0
    ) {
      const incoming = filesChangedBetween("HEAD", b.ref, cwd, runner);
      collisions = detectLockCollisions(incoming, deps.heldPathsByOthers);
      if (collisions.length > 0) {
        entry.lockCollisions = collisions;
        notices.push(
          `⚠ heads-up: ${b.member}'s changes touch ${collisions.length} file(s) a teammate ` +
            `is editing now (${collisions.slice(0, 3).join(", ")}` +
            `${collisions.length > 3 ? ", …" : ""}) — coordinate before merging.`,
        );
      }
    }

    if (config.autoMerge) {
      if (collisions.length > 0) {
        // Never auto-merge over live edits; defer to a deliberate manual merge.
        notices.push(
          `auto-sync: deferred auto-merge of ${b.member} (touches files in active use). ` +
            `Review, then run: cfls sync merge ${b.member}`,
        );
      } else {
        const result = mergeNoConflict(b.ref, cwd, runner);
        if (result.ok) {
          entry.merged = true;
          notices.push(`auto-sync: merged ${b.member}'s changes cleanly.`);
        } else {
          entry.conflicted = true;
          notices.push(
            `auto-sync: manual merge needed for ${b.member} — conflicts detected, ` +
              `merge aborted. Run: cfls sync merge ${b.member}`,
          );
        }
      }
    }
    advanced.push(entry);
  }

  return { advanced, tips, notices, fetchFailed: false };
}

/** Options for {@link startGitSyncLoop}. */
export interface GitSyncLoopOptions extends SyncDeps {
  /** Sink for notices (defaults to `console.log`). Secret-free strings only. */
  onNotice?: (notice: SyncNotice) => void;
  /**
   * OPTIONAL provider returning the live set of repo-relative paths OTHER
   * teammates are editing/holding right now. Called fresh each consumer cycle so
   * the pre-warning always reflects current coordination state. When omitted the
   * pre-warning is disabled (unchanged behavior).
   */
  getHeldPathsByOthers?: () => ReadonlySet<string>;
  /** Injectable timers (tests). Defaults to global `setInterval`/`clearInterval`. */
  setIntervalFn?: (
    handler: () => void,
    ms: number,
  ) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (handle: ReturnType<typeof setInterval>) => void;
}

/** A running sync loop handle. */
export interface GitSyncLoopHandle {
  /** Cancel all timers. Idempotent; safe to call from the shutdown path. */
  stop: () => void;
}

/**
 * Start the background sync loop. Returns a no-op handle (and starts nothing)
 * when `config.enabled` is false, so this is safe to call unconditionally from
 * `cfls agent`. The producer and consumer run on independent timers; every tick
 * is wrapped so a thrown error is caught and reported as a notice rather than
 * crashing the agent. `stop()` clears both timers and is wired into the existing
 * SIGINT/shutdown flow by the caller.
 */
export function startGitSyncLoop(
  options: GitSyncLoopOptions,
): GitSyncLoopHandle {
  const { config } = options;
  if (!config.enabled) {
    return { stop: () => {} };
  }

  const onNotice = options.onNotice ?? ((n) => console.log(n));
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  const deps: SyncDeps = {
    cwd: options.cwd,
    config: options.config,
    member: options.member,
    runner: options.runner,
  };

  let consumerTips = new Map<string, string>();

  const runProducer = (): void => {
    try {
      const result = decideProducer(deps);
      for (const notice of result.notices) {
        onNotice(notice);
      }
    } catch (error) {
      onNotice(
        `auto-sync: producer error (continuing): ${describeError(error)}`,
      );
    }
  };

  const runConsumer = (): void => {
    try {
      const held = options.getHeldPathsByOthers?.();
      const consumerDeps: SyncDeps =
        held !== undefined ? { ...deps, heldPathsByOthers: held } : deps;
      const result = decideConsumer(consumerDeps, consumerTips);
      consumerTips = result.tips;
      for (const notice of result.notices) {
        onNotice(notice);
      }
    } catch (error) {
      onNotice(
        `auto-sync: consumer error (continuing): ${describeError(error)}`,
      );
    }
  };

  const producerTimer = setIntervalFn(
    runProducer,
    config.commitIntervalSec * 1000,
  );
  const consumerTimer = setIntervalFn(
    runConsumer,
    config.fetchIntervalSec * 1000,
  );
  // Do not keep the event loop alive solely for these timers; the agent's own
  // connection keeps the process running, and Ctrl+C should still exit promptly.
  producerTimer.unref?.();
  consumerTimer.unref?.();

  let stopped = false;
  return {
    stop: (): void => {
      if (stopped) {
        return;
      }
      stopped = true;
      clearIntervalFn(producerTimer);
      clearIntervalFn(consumerTimer);
    },
  };
}

/** Format an unknown error as a concise, secret-free string. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Re-export the default runner so callers can build a real loop tersely. */
export { defaultGitRunner };
