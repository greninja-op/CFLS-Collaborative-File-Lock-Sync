/**
 * Unit tests for canonical repository ID derivation (Req 10.1; design §9.1).
 * Covers the design's worked example (SSH / HTTPS / `.git` variants collapse),
 * schemes with credentials and ports, host case-folding, and trailing slashes.
 */

import { describe, expect, it } from "vitest";

import { deriveRepoId } from "./repo-id";

describe("deriveRepoId", () => {
  it("collapses the design's SSH / HTTPS / .git variants to one ID", () => {
    const expected = "github.com/acme/app";
    expect(deriveRepoId("git@github.com:acme/app.git")).toBe(expected);
    expect(deriveRepoId("https://github.com/acme/app.git")).toBe(expected);
    expect(deriveRepoId("https://github.com/acme/app")).toBe(expected);
  });

  it("strips ssh:// scheme, credentials, and port", () => {
    expect(deriveRepoId("ssh://git@github.com:22/acme/app.git")).toBe(
      "github.com/acme/app",
    );
  });

  it("strips http(s) credentials and port", () => {
    expect(deriveRepoId("https://user:pass@gitlab.com:443/team/repo.git")).toBe(
      "gitlab.com/team/repo",
    );
  });

  it("handles the git:// protocol", () => {
    expect(deriveRepoId("git://example.org/foo/bar.git")).toBe(
      "example.org/foo/bar",
    );
  });

  it("lower-cases the host but preserves path case", () => {
    expect(deriveRepoId("https://GitHub.COM/Acme/App.git")).toBe(
      "github.com/Acme/App",
    );
  });

  it("strips a trailing slash", () => {
    expect(deriveRepoId("https://github.com/acme/app/")).toBe(
      "github.com/acme/app",
    );
    expect(deriveRepoId("https://github.com/acme/app.git/")).toBe(
      "github.com/acme/app",
    );
  });

  it("accepts an already-canonical host/path value unchanged", () => {
    expect(deriveRepoId("github.com/acme/app")).toBe("github.com/acme/app");
  });

  it("handles nested group paths (e.g. GitLab subgroups)", () => {
    expect(deriveRepoId("git@gitlab.com:group/subgroup/repo.git")).toBe(
      "gitlab.com/group/subgroup/repo",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(deriveRepoId("  https://github.com/acme/app.git \n")).toBe(
      "github.com/acme/app",
    );
  });

  it("throws on an empty remote", () => {
    expect(() => deriveRepoId("")).toThrow();
    expect(() => deriveRepoId("   ")).toThrow();
  });
});
