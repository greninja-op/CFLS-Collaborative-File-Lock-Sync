/**
 * Unit tests for the local encrypted cache (task 9.9; Req 35.1, 35.3, 35.4).
 * Verifies an encrypt/decrypt round-trip and that no plaintext coordination
 * metadata (or incidental source) is readable on disk.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sessionKey } from "@cfls/core-state";
import type { SessionId, SessionStateSnapshot } from "@cfls/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EncryptedCache } from "./cache";

const session: SessionId = {
  repoId: "github.com/acme/app",
  teamId: "team-1",
  branch: "main",
  baseRevision: null,
};

function snapshot(): SessionStateSnapshot {
  return {
    session,
    locks: [
      {
        lockId: "lk-1",
        scope: "src/very-secret-path.ts",
        scopeKind: "file",
        mode: "soft",
        holder: { memberId: "alice", deviceId: "dev-a" },
        branch: "main",
        eventRevision: 3,
        acquiredAt: "2024-01-01T00:00:00Z",
        concurrent: false,
      },
    ],
    presence: [],
    intents: [],
    highestRevision: 3,
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cfls-cache-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("EncryptedCache (Req 35.1, 35.3)", () => {
  it("round-trips a snapshot through encrypt → decrypt", () => {
    const cache = new EncryptedCache({ dir, passphrase: "device-private-key" });
    cache.save(session, snapshot());
    const loaded = cache.load(session);
    expect(loaded).toEqual(snapshot());
  });

  it("stores no plaintext coordination metadata on disk", () => {
    const cache = new EncryptedCache({ dir, passphrase: "device-private-key" });
    cache.save(session, snapshot());
    // Read the raw on-disk bytes and assert the sensitive path never appears.
    const raw = readFileSync(join(dir, `${sessionKey(session)}.cache`), "utf8");
    expect(raw).not.toContain("very-secret-path");
    expect(raw).not.toContain("alice");
    expect(raw).not.toContain("github.com/acme/app");
  });

  it("returns null when nothing is cached for a session", () => {
    const cache = new EncryptedCache({ dir, passphrase: "k" });
    expect(cache.load(session)).toBeNull();
  });

  it("cannot be decrypted with a different passphrase", () => {
    new EncryptedCache({ dir, passphrase: "correct" }).save(
      session,
      snapshot(),
    );
    // A wrong passphrase fails the GCM auth tag and yields null (not a throw).
    expect(
      new EncryptedCache({ dir, passphrase: "wrong" }).load(session),
    ).toBeNull();
  });

  it("refuses to cache a snapshot carrying source content (Req 35.3)", () => {
    const cache = new EncryptedCache({ dir, passphrase: "k" });
    const withSource = {
      ...snapshot(),
      // A rogue field carrying file contents must be rejected before writing.
      fileContents: "export const secret = 42;",
    } as unknown as SessionStateSnapshot;
    expect(() => cache.save(session, withSource)).toThrow();
  });
});
