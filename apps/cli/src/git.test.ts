/**
 * Unit tests for git-based Repository_Session derivation (Req 10.1, 10.6).
 *
 * The git binary is mocked via an injected {@link GitRunner}, so these tests
 * exercise the pure fact-collection + session-resolution logic without shelling
 * out. They assert that the derived `repoId` is the canonical form (transport
 * variants collapse) and that the manual fallback is used when git is absent.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  collectGitFacts,
  enableRerere,
  filesChangedBetween,
  listConflictedFiles,
  listTrackingBranches,
  mergeLeavingConflicts,
  mergeNoConflict,
  mergeReportingConflicts,
  parseForEachRef,
  parseLeftRightCount,
  parsePorcelain,
  push,
  sanitizeMemberName,
  stagePaths,
  userBranchName,
  workingTreeChanges,
  type GitCommandResult,
  type GitRunner,
} from "./git";
import { resolveRepositorySession } from "./session";

/** Build a mock runner from a map of "arg arg" → stdout (missing ⇒ failure). */
function mockRunner(map: Record<string, string>): GitRunner {
  return (args) => {
    const key = args.join(" ");
    const stdout = map[key];
    return stdout === undefined ? { ok: false, stdout: "" } : { ok: true, stdout };
  };
}

/** A runner that records every invocation for assertion on command construction. */
function recordingRunner(
  responder: (args: readonly string[]) => GitCommandResult,
): { runner: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: GitRunner = (args) => {
    calls.push([...args]);
    return responder(args);
  };
  return { runner, calls };
}

describe("collectGitFacts", () => {
  it("collects remote, branch, and base revision", () => {
    const runner = mockRunner({
      "remote get-url origin": "git@github.com:acme/app.git",
      "rev-parse --abbrev-ref HEAD": "main",
      "rev-parse HEAD": "abc123def456",
    });
    expect(collectGitFacts("/repo", runner)).toEqual({
      remoteUrl: "git@github.com:acme/app.git",
      branch: "main",
      baseRevision: "abc123def456",
    });
  });

  it("returns null facts when git commands fail", () => {
    const runner = mockRunner({});
    expect(collectGitFacts("/not-a-repo", runner)).toEqual({
      remoteUrl: null,
      branch: null,
      baseRevision: null,
    });
  });
});

describe("resolveRepositorySession", () => {
  it("derives the canonical repoId from the git remote (transport-independent)", () => {
    const runner = mockRunner({
      "remote get-url origin": "https://github.com/acme/app.git",
      "rev-parse --abbrev-ref HEAD": "feature/login",
      "rev-parse HEAD": "deadbeef",
    });
    const { session, manualConfig } = resolveRepositorySession({
      repoRoot: "/repo",
      teamId: "team-x",
      gitRunner: runner,
    });
    expect(manualConfig).toBe(false);
    expect(session).toEqual({
      repoId: "github.com/acme/app",
      teamId: "team-x",
      branch: "feature/login",
      baseRevision: "deadbeef",
    });
  });

  it("honors an explicit --repo override over the discovered remote", () => {
    const runner = mockRunner({
      "remote get-url origin": "git@github.com:acme/wrong.git",
      "rev-parse --abbrev-ref HEAD": "main",
      "rev-parse HEAD": "c0ffee",
    });
    const { session } = resolveRepositorySession({
      repoRoot: "/repo",
      teamId: "team-x",
      remoteUrlOverride: "https://gitlab.com/team/repo.git",
      gitRunner: runner,
    });
    expect(session.repoId).toBe("gitlab.com/team/repo");
  });

  describe("manual fallback", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "cfls-cli-git-"));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("falls back to .coordination/session.json when git is unavailable", () => {
      mkdirSync(join(dir, ".coordination"), { recursive: true });
      writeFileSync(
        join(dir, ".coordination", "session.json"),
        JSON.stringify({
          repoId: "example.com/manual/repo",
          teamId: "manual-team",
          branch: "main",
          baseRevision: null,
        }),
      );
      const { session, manualConfig } = resolveRepositorySession({
        repoRoot: dir,
        teamId: "ignored-when-manual",
        gitRunner: mockRunner({}),
      });
      expect(manualConfig).toBe(true);
      expect(session.repoId).toBe("example.com/manual/repo");
      expect(session.teamId).toBe("manual-team");
    });

    it("throws a clear error when neither git nor a manual file exists", () => {
      expect(() =>
        resolveRepositorySession({ repoRoot: dir, gitRunner: mockRunner({}) }),
      ).toThrow(/Repository_Session/);
    });
  });
});

// ---------------------------------------------------------------------------
// Automatic git sync helpers (Model A)
// ---------------------------------------------------------------------------

describe("branch naming", () => {
  it("builds cfls/<member> and sanitizes ref-unsafe characters", () => {
    expect(userBranchName("cfls/", "alice")).toBe("cfls/alice");
    expect(userBranchName("cfls/", "Bob Smith")).toBe("cfls/Bob-Smith");
    expect(sanitizeMemberName("  weird//name.. ")).toBe("weird-name");
  });
});

describe("parsePorcelain", () => {
  it("parses NUL-delimited porcelain into changed paths (ignored excluded by git)", () => {
    // `git status --porcelain=v1 -z` output: entries joined by NUL.
    const stdout = [" M src/a.ts", "A  src/b.ts", "?? new.txt"].join("\0") + "\0";
    expect(parsePorcelain(stdout)).toEqual([
      { status: " M", path: "src/a.ts" },
      { status: "A ", path: "src/b.ts" },
      { status: "??", path: "new.txt" },
    ]);
  });

  it("keeps the destination path of a rename and skips its 'from' token", () => {
    const stdout = ["R  new/name.ts", "old/name.ts", " M other.ts"].join("\0") + "\0";
    expect(parsePorcelain(stdout)).toEqual([
      { status: "R ", path: "new/name.ts" },
      { status: " M", path: "other.ts" },
    ]);
  });

  it("returns [] for empty output", () => {
    expect(parsePorcelain("")).toEqual([]);
  });
});

describe("workingTreeChanges", () => {
  it("returns parsed changes on success", () => {
    const runner = mockRunner({
      "status --porcelain=v1 -z": " M src/a.ts\0?? b.ts\0",
    });
    expect(workingTreeChanges("/repo", runner)).toEqual([
      { status: " M", path: "src/a.ts" },
      { status: "??", path: "b.ts" },
    ]);
  });

  it("treats a git failure as no changes (safe no-op)", () => {
    expect(workingTreeChanges("/repo", mockRunner({}))).toEqual([]);
  });
});

describe("stagePaths", () => {
  it("never uses `git add .` — stages only the listed paths after `--`", () => {
    const { runner, calls } = recordingRunner(() => ({ ok: true, stdout: "" }));
    stagePaths(["src/a.ts", "src/b.ts"], "/repo", runner);
    expect(calls).toEqual([["add", "--", "src/a.ts", "src/b.ts"]]);
  });

  it("is a no-op for an empty path list", () => {
    const { runner, calls } = recordingRunner(() => ({ ok: true, stdout: "" }));
    expect(stagePaths([], "/repo", runner)).toEqual({ ok: true, stdout: "" });
    expect(calls).toEqual([]);
  });
});

describe("push", () => {
  it("publishes HEAD to refs/heads/<branch> without force and without switching", () => {
    const { runner, calls } = recordingRunner(() => ({ ok: true, stdout: "" }));
    push("origin", "cfls/alice", "/repo", runner);
    expect(calls).toEqual([["push", "origin", "HEAD:refs/heads/cfls/alice"]]);
    // Never a --force / +refspec.
    expect(calls[0]?.join(" ")).not.toMatch(/force|\+/);
  });
});

describe("parseForEachRef / parseLeftRightCount", () => {
  it("keeps only <remote>/<prefix>* refs and extracts member + commit", () => {
    const stdout = [
      "origin/cfls/alice aaa111",
      "origin/cfls/bob bbb222",
      "origin/main ccc333", // not under the prefix
      "origin/feature/x ddd444", // not under the prefix
    ].join("\n");
    expect(parseForEachRef(stdout, "origin", "cfls/")).toEqual([
      { ref: "origin/cfls/alice", branch: "cfls/alice", member: "alice", commit: "aaa111" },
      { ref: "origin/cfls/bob", branch: "cfls/bob", member: "bob", commit: "bbb222" },
    ]);
  });

  it("parses left/right ahead-behind counts", () => {
    expect(parseLeftRightCount("2\t5")).toEqual({ left: 2, right: 5 });
    expect(parseLeftRightCount("bogus")).toEqual({ left: 0, right: 0 });
  });
});

describe("listTrackingBranches", () => {
  it("lists cfls/* branches with ahead/behind relative to HEAD", () => {
    const runner = mockRunner({
      "for-each-ref --format=%(refname:short) %(objectname) refs/remotes/origin/cfls/":
        "origin/cfls/alice aaa111\norigin/cfls/bob bbb222",
      // HEAD is behind alice by 3 (right), ahead by 1 (left).
      "rev-list --left-right --count HEAD...origin/cfls/alice": "1\t3",
      // HEAD is even with bob.
      "rev-list --left-right --count HEAD...origin/cfls/bob": "0\t0",
    });
    expect(listTrackingBranches("origin", "cfls/", "/repo", runner)).toEqual([
      {
        ref: "origin/cfls/alice",
        branch: "cfls/alice",
        member: "alice",
        commit: "aaa111",
        ahead: 3,
        behind: 1,
      },
      {
        ref: "origin/cfls/bob",
        branch: "cfls/bob",
        member: "bob",
        commit: "bbb222",
        ahead: 0,
        behind: 0,
      },
    ]);
  });

  it("returns [] when for-each-ref fails", () => {
    expect(listTrackingBranches("origin", "cfls/", "/repo", mockRunner({}))).toEqual([]);
  });
});

describe("mergeNoConflict", () => {
  it("returns ok on a clean merge and never aborts", () => {
    const { runner, calls } = recordingRunner((args) =>
      args[0] === "merge" ? { ok: true, stdout: "Fast-forward" } : { ok: true, stdout: "" },
    );
    expect(mergeNoConflict("origin/cfls/alice", "/repo", runner)).toEqual({
      ok: true,
      conflicted: false,
      alreadyUpToDate: false,
    });
    expect(calls).toEqual([["merge", "--no-edit", "origin/cfls/alice"]]);
  });

  it("detects an already-up-to-date merge", () => {
    const runner = mockRunner({
      "merge --no-edit origin/cfls/bob": "Already up to date.",
    });
    expect(mergeNoConflict("origin/cfls/bob", "/repo", runner)).toEqual({
      ok: true,
      conflicted: false,
      alreadyUpToDate: true,
    });
  });

  it("aborts on conflict and reports conflicted without leaving a dirty tree", () => {
    const { runner, calls } = recordingRunner((args) =>
      args[0] === "merge" && args[1] === "--no-edit"
        ? { ok: false, stdout: "CONFLICT" }
        : { ok: true, stdout: "" },
    );
    expect(mergeNoConflict("origin/cfls/alice", "/repo", runner)).toEqual({
      ok: false,
      conflicted: true,
    });
    // The second call MUST be the abort.
    expect(calls[0]).toEqual(["merge", "--no-edit", "origin/cfls/alice"]);
    expect(calls[1]).toEqual(["merge", "--abort"]);
  });
});

describe("enableRerere", () => {
  it("runs `git config rerere.enabled true`", () => {
    const { runner, calls } = recordingRunner(() => ({ ok: true, stdout: "" }));
    expect(enableRerere("/repo", runner).ok).toBe(true);
    expect(calls).toEqual([["config", "rerere.enabled", "true"]]);
  });
});

describe("listConflictedFiles", () => {
  it("parses NUL-delimited unmerged paths", () => {
    const runner = mockRunner({
      "diff --name-only --diff-filter=U -z": "src/a.ts\0src/b.ts\0",
    });
    expect(listConflictedFiles("/repo", runner)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("returns [] on git failure", () => {
    expect(listConflictedFiles("/repo", mockRunner({}))).toEqual([]);
  });
});

describe("filesChangedBetween", () => {
  it("uses the three-dot (merge-base) diff and parses NUL output", () => {
    const { runner, calls } = recordingRunner(() => ({
      ok: true,
      stdout: "src/x.ts\0src/y.ts\0",
    }));
    expect(filesChangedBetween("HEAD", "origin/cfls/bob", "/repo", runner)).toEqual([
      "src/x.ts",
      "src/y.ts",
    ]);
    expect(calls[0]).toEqual([
      "diff",
      "--name-only",
      "-z",
      "HEAD...origin/cfls/bob",
    ]);
  });
});

describe("mergeReportingConflicts", () => {
  it("captures the conflicted files then aborts (tree restored)", () => {
    const { runner, calls } = recordingRunner((args) => {
      if (args[0] === "merge" && args[1] === "--no-edit") {
        return { ok: false, stdout: "CONFLICT" };
      }
      if (args.join(" ") === "diff --name-only --diff-filter=U -z") {
        return { ok: true, stdout: "src/a.ts\0" };
      }
      return { ok: true, stdout: "" };
    });
    expect(mergeReportingConflicts("origin/cfls/bob", "/repo", runner)).toEqual({
      ok: false,
      conflicted: true,
      conflictedFiles: ["src/a.ts"],
    });
    // Must have aborted to restore the tree.
    expect(calls).toContainEqual(["merge", "--abort"]);
  });

  it("reports a clean merge with no conflicted files", () => {
    const runner = mockRunner({ "merge --no-edit origin/cfls/bob": "Fast-forward" });
    expect(mergeReportingConflicts("origin/cfls/bob", "/repo", runner)).toEqual({
      ok: true,
      conflicted: false,
      alreadyUpToDate: false,
      conflictedFiles: [],
    });
  });
});

describe("mergeLeavingConflicts", () => {
  it("does NOT abort on conflict — leaves markers for manual resolution", () => {
    const { runner, calls } = recordingRunner((args) => {
      if (args[0] === "merge" && args[1] === "--no-edit") {
        return { ok: false, stdout: "CONFLICT" };
      }
      if (args.join(" ") === "diff --name-only --diff-filter=U -z") {
        return { ok: true, stdout: "src/a.ts\0src/b.ts\0" };
      }
      return { ok: true, stdout: "" };
    });
    expect(mergeLeavingConflicts("origin/cfls/bob", "/repo", runner)).toEqual({
      ok: false,
      conflicted: true,
      conflictedFiles: ["src/a.ts", "src/b.ts"],
    });
    // Crucially, NO abort was issued.
    expect(calls).not.toContainEqual(["merge", "--abort"]);
  });
});
