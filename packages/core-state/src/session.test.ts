/**
 * Unit tests for session identity and session_key hashing (Req 10.1–10.2; §9).
 * Covers determinism, isolation across differing fields, null baseRevision
 * handling, and repo-id canonicalization in buildSessionId.
 */

import { describe, expect, it } from "vitest";

import type { SessionId } from "@cfls/protocol";

import { buildSessionId, sessionKey } from "./session";

const base: SessionId = {
  repoId: "github.com/acme/app",
  teamId: "team-1",
  branch: "main",
  baseRevision: "abc123",
};

describe("sessionKey", () => {
  it("is deterministic for equal session tuples", () => {
    expect(sessionKey(base)).toBe(sessionKey({ ...base }));
  });

  it("produces a base64url string with no padding", () => {
    expect(sessionKey(base)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("differs when any field differs (isolation, Req 10.2)", () => {
    const key = sessionKey(base);
    expect(sessionKey({ ...base, repoId: "github.com/acme/other" })).not.toBe(key);
    expect(sessionKey({ ...base, teamId: "team-2" })).not.toBe(key);
    expect(sessionKey({ ...base, branch: "dev" })).not.toBe(key);
    expect(sessionKey({ ...base, baseRevision: "def456" })).not.toBe(key);
  });

  it("distinguishes a null baseRevision from any string value", () => {
    const withNull = sessionKey({ ...base, baseRevision: null });
    const withEmpty = sessionKey({ ...base, baseRevision: "" });
    expect(withNull).not.toBe(withEmpty);
  });

  it("does not confuse field boundaries (length-prefixed encoding)", () => {
    // Moving characters across the repoId/teamId boundary must change the key.
    const a = sessionKey({ ...base, repoId: "a", teamId: "bc" });
    const b = sessionKey({ ...base, repoId: "ab", teamId: "c" });
    expect(a).not.toBe(b);
  });
});

describe("buildSessionId", () => {
  it("canonicalizes the repo ID from a raw remote", () => {
    const session = buildSessionId({
      remote: "git@github.com:acme/app.git",
      teamId: "team-1",
      branch: "main",
      baseRevision: "abc123",
    });
    expect(session.repoId).toBe("github.com/acme/app");
  });

  it("keys transport variants of the same repo identically", () => {
    const ssh = buildSessionId({
      remote: "git@github.com:acme/app.git",
      teamId: "team-1",
      branch: "main",
      baseRevision: "abc123",
    });
    const https = buildSessionId({
      remote: "https://github.com/acme/app",
      teamId: "team-1",
      branch: "main",
      baseRevision: "abc123",
    });
    expect(sessionKey(ssh)).toBe(sessionKey(https));
  });

  it("defaults baseRevision to null when omitted", () => {
    const session = buildSessionId({
      remote: "github.com/acme/app",
      teamId: "team-1",
      branch: "main",
    });
    expect(session.baseRevision).toBeNull();
  });
});
