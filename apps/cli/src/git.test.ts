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

import { collectGitFacts, type GitRunner } from "./git";
import { resolveRepositorySession } from "./session";

/** Build a mock runner from a map of "arg arg" → stdout (missing ⇒ failure). */
function mockRunner(map: Record<string, string>): GitRunner {
  return (args) => {
    const key = args.join(" ");
    const stdout = map[key];
    return stdout === undefined ? { ok: false, stdout: "" } : { ok: true, stdout };
  };
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
