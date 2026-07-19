/**
 * Unit tests for the opt-in automatic git sync producer/consumer decision logic
 * (Model A: per-user branches). Every git access is routed through a MOCKED
 * {@link GitRunner}; no real git is invoked and the real repo is never touched.
 *
 * Coverage:
 *   - producer: nothing-to-commit skip, commit+push command construction,
 *     push-failure notice (no secrets), never `git add .`.
 *   - consumer: fetch + ahead/behind detection, own-branch exclusion,
 *     autoMerge clean vs conflict (abort) paths, unchanged-tip skip.
 *   - loop: disabled config starts nothing; timers are cancellable.
 */

import { describe, expect, it, vi } from "vitest";

import { DEFAULT_AUTO_SYNC, type AutoSyncConfig } from "./config-files";
import type { GitCommandResult, GitRunner } from "./git";
import {
  buildCommitMessage,
  decideConsumer,
  decideProducer,
  detectLockCollisions,
  startGitSyncLoop,
  type SyncDeps,
} from "./git-sync";

/** A recording runner driven by a responder keyed on the joined args. */
function scriptedRunner(
  responder: (key: string, args: readonly string[]) => GitCommandResult,
): { runner: GitRunner; calls: string[] } {
  const calls: string[] = [];
  const runner: GitRunner = (args) => {
    const key = args.join(" ");
    calls.push(key);
    return responder(key, args);
  };
  return { runner, calls };
}

function cfg(overrides: Partial<AutoSyncConfig> = {}): AutoSyncConfig {
  return { ...DEFAULT_AUTO_SYNC, enabled: true, ...overrides };
}

describe("buildCommitMessage", () => {
  it("pluralizes correctly", () => {
    expect(buildCommitMessage("alice", 1)).toBe("cfls: alice sync 1 file");
    expect(buildCommitMessage("alice", 3)).toBe("cfls: alice sync 3 files");
  });
});

describe("decideProducer", () => {
  it("skips cleanly when the working tree has no changes", () => {
    const { runner, calls } = scriptedRunner((key) =>
      key === "status --porcelain=v1 -z" ? { ok: true, stdout: "" } : { ok: true, stdout: "" },
    );
    const deps: SyncDeps = { cwd: "/repo", config: cfg(), member: "alice", runner };
    const result = decideProducer(deps);
    expect(result.action).toBe("skipped");
    expect(result.changedCount).toBe(0);
    // Only the status probe should have run — no add/commit/push.
    expect(calls).toEqual(["status --porcelain=v1 -z"]);
  });

  it("stages only changed paths, commits, and pushes to cfls/<member>", () => {
    const { runner, calls } = scriptedRunner((key) => {
      if (key === "status --porcelain=v1 -z") {
        return { ok: true, stdout: " M src/a.ts\0?? src/b.ts\0" };
      }
      return { ok: true, stdout: "" };
    });
    const deps: SyncDeps = { cwd: "/repo", config: cfg(), member: "alice", runner };
    const result = decideProducer(deps);
    expect(result.action).toBe("pushed");
    expect(result.changedCount).toBe(2);
    expect(calls).toContain("add -- src/a.ts src/b.ts");
    expect(calls).toContain("commit -m cfls: alice sync 2 files");
    expect(calls).toContain("push origin HEAD:refs/heads/cfls/alice");
    // Never `git add .` / `-A`.
    expect(calls.some((c) => /^add (\.|-A)/.test(c))).toBe(false);
  });

  it("reports a push failure without leaking secrets and keeps going", () => {
    const { runner } = scriptedRunner((key) => {
      if (key === "status --porcelain=v1 -z") {
        return { ok: true, stdout: " M src/a.ts\0" };
      }
      if (key.startsWith("push")) {
        return { ok: false, stdout: "" };
      }
      return { ok: true, stdout: "" };
    });
    const deps: SyncDeps = { cwd: "/repo", config: cfg(), member: "alice", runner };
    const result = decideProducer(deps);
    expect(result.action).toBe("push-failed");
    expect(result.notices.join(" ")).toMatch(/rejected/);
    // No token/credential text present.
    expect(result.notices.join(" ")).not.toMatch(/token|password|secret/i);
  });

  it("reports a commit failure (nothing staged) as commit-failed", () => {
    const { runner } = scriptedRunner((key) => {
      if (key === "status --porcelain=v1 -z") {
        return { ok: true, stdout: " M src/a.ts\0" };
      }
      if (key.startsWith("commit")) {
        return { ok: false, stdout: "" };
      }
      return { ok: true, stdout: "" };
    });
    const deps: SyncDeps = { cwd: "/repo", config: cfg(), member: "alice", runner };
    expect(decideProducer(deps).action).toBe("commit-failed");
  });
});

describe("decideConsumer", () => {
  const listKey =
    "for-each-ref --format=%(refname:short) %(objectname) refs/remotes/origin/cfls/";

  function baseRunner(overrides: Record<string, GitCommandResult> = {}): {
    runner: GitRunner;
    calls: string[];
  } {
    return scriptedRunner((key) => {
      if (key in overrides) {
        return overrides[key] as GitCommandResult;
      }
      if (key.startsWith("fetch")) {
        return { ok: true, stdout: "" };
      }
      return { ok: false, stdout: "" };
    });
  }

  it("fetches and notifies for an advanced teammate branch (notify-only)", () => {
    const { runner, calls } = baseRunner({
      [listKey]: { ok: true, stdout: "origin/cfls/bob bbb222" },
      "rev-list --left-right --count HEAD...origin/cfls/bob": { ok: true, stdout: "0\t2" },
    });
    const deps: SyncDeps = { cwd: "/repo", config: cfg(), member: "alice", runner };
    const result = decideConsumer(deps, new Map());
    expect(calls[0]).toMatch(/^fetch/);
    expect(result.advanced).toHaveLength(1);
    expect(result.advanced[0]).toMatchObject({ member: "bob", ahead: 2 });
    expect(result.notices.some((n) => /bob published 2 commits/.test(n))).toBe(true);
    // No merge attempted when autoMerge is off.
    expect(calls.some((c) => c.startsWith("merge"))).toBe(false);
    expect(result.tips.get("cfls/bob")).toBe("bbb222");
  });

  it("excludes the current user's own publish branch", () => {
    const { runner } = baseRunner({
      [listKey]: { ok: true, stdout: "origin/cfls/alice aaa111" },
      "rev-list --left-right --count HEAD...origin/cfls/alice": { ok: true, stdout: "0\t5" },
    });
    const deps: SyncDeps = { cwd: "/repo", config: cfg(), member: "alice", runner };
    const result = decideConsumer(deps, new Map());
    expect(result.advanced).toHaveLength(0);
  });

  it("skips a branch whose tip has not changed since last cycle", () => {
    const { runner } = baseRunner({
      [listKey]: { ok: true, stdout: "origin/cfls/bob bbb222" },
      "rev-list --left-right --count HEAD...origin/cfls/bob": { ok: true, stdout: "0\t2" },
    });
    const deps: SyncDeps = { cwd: "/repo", config: cfg(), member: "alice", runner };
    const previous = new Map([["cfls/bob", "bbb222"]]);
    expect(decideConsumer(deps, previous).advanced).toHaveLength(0);
  });

  it("autoMerge: applies a conflict-free merge and reports merged", () => {
    const { runner, calls } = baseRunner({
      [listKey]: { ok: true, stdout: "origin/cfls/bob bbb222" },
      "rev-list --left-right --count HEAD...origin/cfls/bob": { ok: true, stdout: "0\t2" },
      "merge --no-edit origin/cfls/bob": { ok: true, stdout: "Fast-forward" },
    });
    const deps: SyncDeps = { cwd: "/repo", config: cfg({ autoMerge: true }), member: "alice", runner };
    const result = decideConsumer(deps, new Map());
    expect(result.advanced[0]).toMatchObject({ merged: true });
    expect(result.notices.some((n) => /merged bob's changes cleanly/.test(n))).toBe(true);
    expect(calls).not.toContain("merge --abort");
  });

  it("autoMerge: aborts on conflict and reports manual merge needed", () => {
    const { runner, calls } = baseRunner({
      [listKey]: { ok: true, stdout: "origin/cfls/bob bbb222" },
      "rev-list --left-right --count HEAD...origin/cfls/bob": { ok: true, stdout: "0\t2" },
      "merge --no-edit origin/cfls/bob": { ok: false, stdout: "CONFLICT" },
    });
    const deps: SyncDeps = { cwd: "/repo", config: cfg({ autoMerge: true }), member: "alice", runner };
    const result = decideConsumer(deps, new Map());
    expect(result.advanced[0]).toMatchObject({ conflicted: true });
    expect(result.notices.some((n) => /manual merge needed for bob/.test(n))).toBe(true);
    // The tree must be restored via abort.
    expect(calls).toContain("merge --abort");
  });

  it("reports a fetch failure and retries next cycle (no crash)", () => {
    const { runner } = scriptedRunner((key) =>
      key.startsWith("fetch") ? { ok: false, stdout: "" } : { ok: false, stdout: "" },
    );
    const deps: SyncDeps = { cwd: "/repo", config: cfg(), member: "alice", runner };
    const result = decideConsumer(deps, new Map());
    expect(result.fetchFailed).toBe(true);
    expect(result.advanced).toHaveLength(0);
  });

  it("pre-warns when an incoming branch touches a file a teammate is editing", () => {
    const { runner } = baseRunner({
      [listKey]: { ok: true, stdout: "origin/cfls/bob bbb222" },
      "rev-list --left-right --count HEAD...origin/cfls/bob": { ok: true, stdout: "0\t2" },
      "diff --name-only -z HEAD...origin/cfls/bob": { ok: true, stdout: "src/shared.ts\0" },
    });
    const deps: SyncDeps = {
      cwd: "/repo",
      config: cfg(), // notify-only
      member: "alice",
      runner,
      heldPathsByOthers: new Set(["src/shared.ts"]),
    };
    const result = decideConsumer(deps, new Map());
    expect(result.advanced[0]?.lockCollisions).toEqual(["src/shared.ts"]);
    expect(result.notices.some((n) => /heads-up/.test(n) && /src\/shared\.ts/.test(n))).toBe(true);
  });

  it("defers an autoMerge (never merges) when it would touch a file in active use", () => {
    const { runner, calls } = baseRunner({
      [listKey]: { ok: true, stdout: "origin/cfls/bob bbb222" },
      "rev-list --left-right --count HEAD...origin/cfls/bob": { ok: true, stdout: "0\t2" },
      "diff --name-only -z HEAD...origin/cfls/bob": { ok: true, stdout: "src/shared.ts\0" },
    });
    const deps: SyncDeps = {
      cwd: "/repo",
      config: cfg({ autoMerge: true }),
      member: "alice",
      runner,
      heldPathsByOthers: new Set(["src/shared.ts"]),
    };
    const result = decideConsumer(deps, new Map());
    expect(result.advanced[0]?.merged).toBeUndefined();
    expect(result.notices.some((n) => /deferred auto-merge/.test(n))).toBe(true);
    // No merge was attempted at all.
    expect(calls.some((c) => c.startsWith("merge"))).toBe(false);
  });

  it("still auto-merges when the incoming files do not collide with active edits", () => {
    const { runner, calls } = baseRunner({
      [listKey]: { ok: true, stdout: "origin/cfls/bob bbb222" },
      "rev-list --left-right --count HEAD...origin/cfls/bob": { ok: true, stdout: "0\t2" },
      "diff --name-only -z HEAD...origin/cfls/bob": { ok: true, stdout: "src/other.ts\0" },
      "merge --no-edit origin/cfls/bob": { ok: true, stdout: "Fast-forward" },
    });
    const deps: SyncDeps = {
      cwd: "/repo",
      config: cfg({ autoMerge: true }),
      member: "alice",
      runner,
      heldPathsByOthers: new Set(["src/shared.ts"]),
    };
    const result = decideConsumer(deps, new Map());
    expect(result.advanced[0]?.merged).toBe(true);
    expect(calls).toContain("merge --no-edit origin/cfls/bob");
  });
});

describe("detectLockCollisions", () => {
  it("returns the incoming files that a teammate is holding (slash/case-insensitive)", () => {
    const incoming = ["src/Shared.ts", "src/new.ts"];
    const held = new Set(["src\\shared.ts"]);
    expect(detectLockCollisions(incoming, held)).toEqual(["src/Shared.ts"]);
  });

  it("returns [] when nothing is held or nothing incoming", () => {
    expect(detectLockCollisions(["a.ts"], new Set())).toEqual([]);
    expect(detectLockCollisions([], new Set(["a.ts"]))).toEqual([]);
  });
});

describe("startGitSyncLoop", () => {
  it("starts nothing and returns a no-op handle when disabled (default)", () => {
    const setIntervalFn = vi.fn();
    const clearIntervalFn = vi.fn();
    const { runner } = scriptedRunner(() => ({ ok: true, stdout: "" }));
    const handle = startGitSyncLoop({
      cwd: "/repo",
      config: DEFAULT_AUTO_SYNC, // enabled: false
      member: "alice",
      runner,
      setIntervalFn: setIntervalFn as never,
      clearIntervalFn: clearIntervalFn as never,
    });
    expect(setIntervalFn).not.toHaveBeenCalled();
    handle.stop(); // safe no-op
    expect(clearIntervalFn).not.toHaveBeenCalled();
  });

  it("schedules producer + consumer timers when enabled and cancels them on stop", () => {
    const handles = [{ unref: vi.fn() }, { unref: vi.fn() }] as unknown as Array<
      ReturnType<typeof setInterval>
    >;
    let i = 0;
    const setIntervalFn = vi.fn(() => handles[i++] as ReturnType<typeof setInterval>);
    const clearIntervalFn = vi.fn();
    const { runner } = scriptedRunner(() => ({ ok: true, stdout: "" }));

    const handle = startGitSyncLoop({
      cwd: "/repo",
      config: cfg(),
      member: "alice",
      runner,
      onNotice: () => {},
      setIntervalFn: setIntervalFn as never,
      clearIntervalFn: clearIntervalFn as never,
    });
    expect(setIntervalFn).toHaveBeenCalledTimes(2);

    handle.stop();
    expect(clearIntervalFn).toHaveBeenCalledTimes(2);
    // Idempotent.
    handle.stop();
    expect(clearIntervalFn).toHaveBeenCalledTimes(2);
  });

  it("never throws out of a timer tick even if the runner throws", () => {
    const ticks: Array<() => void> = [];
    const setIntervalFn = vi.fn((handler: () => void) => {
      ticks.push(handler);
      return { unref: () => {} } as unknown as ReturnType<typeof setInterval>;
    });
    const notices: string[] = [];
    const throwingRunner: GitRunner = () => {
      throw new Error("boom");
    };
    startGitSyncLoop({
      cwd: "/repo",
      config: cfg(),
      member: "alice",
      runner: throwingRunner,
      onNotice: (n) => notices.push(n),
      setIntervalFn: setIntervalFn as never,
      clearIntervalFn: (() => {}) as never,
    });
    // Fire both timers; neither should throw.
    expect(() => ticks.forEach((t) => t())).not.toThrow();
    expect(notices.some((n) => /error \(continuing\)/.test(n))).toBe(true);
  });
});
