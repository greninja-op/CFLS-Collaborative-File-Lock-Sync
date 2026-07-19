/**
 * Round-trip tests for the CLI config files (host.json, agent.json,
 * local-api.json). Every write must read back exactly, keys must dedupe, and
 * partial agent-config updates must merge rather than clobber.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeFileSync } from "node:fs";

import {
  appendAdminPublicKey,
  DEFAULT_AUTO_SYNC,
  readAgentConfig,
  readAutoSyncConfig,
  readHostConfig,
  readLocalApiConfig,
  readTeamConfig,
  updateAgentConfig,
  writeLocalApiConfig,
} from "./config-files";

describe("config files round-trip", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cfls-cli-cfg-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("host.json: appends + dedupes admin keys and stores the team id", () => {
    const path = join(dir, "host.json");
    expect(readHostConfig(path)).toBeNull();

    appendAdminPublicKey(path, "KEY_A", "team-1");
    appendAdminPublicKey(path, "KEY_B", "team-1");
    appendAdminPublicKey(path, "KEY_A", "team-1"); // duplicate

    const config = readHostConfig(path);
    expect(config).not.toBeNull();
    expect(config?.teamId).toBe("team-1");
    expect(config?.authorizedAdminPublicKeys).toEqual(["KEY_A", "KEY_B"]);
  });

  it("agent.json: merges partial updates instead of clobbering", () => {
    const path = join(dir, "agent.json");
    expect(readAgentConfig(path)).toEqual({});

    updateAgentConfig(path, { hostUrl: "wss://host:8730", memberName: "alice" });
    updateAgentConfig(path, { invitation: "BASE64", teamId: "team-1" });

    expect(readAgentConfig(path)).toEqual({
      hostUrl: "wss://host:8730",
      memberName: "alice",
      invitation: "BASE64",
      teamId: "team-1",
    });
  });

  it("local-api.json: writes and reads the discovery record", () => {
    const path = join(dir, "local-api.json");
    expect(readLocalApiConfig(path)).toBeNull();

    writeLocalApiConfig(path, { url: "ws://127.0.0.1:8750", token: "tok-123" });
    expect(readLocalApiConfig(path)).toEqual({
      url: "ws://127.0.0.1:8750",
      token: "tok-123",
    });
  });
});

describe("config.json autoSync", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cfls-cli-autosync-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns the safe disabled defaults when the file is absent", () => {
    const path = join(dir, "config.json");
    expect(readAutoSyncConfig(path)).toEqual(DEFAULT_AUTO_SYNC);
    expect(readAutoSyncConfig(path).enabled).toBe(false);
    expect(readTeamConfig(path)).toEqual({});
  });

  it("returns disabled defaults when the autoSync block is absent", () => {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ somethingElse: true }));
    expect(readAutoSyncConfig(path)).toEqual(DEFAULT_AUTO_SYNC);
  });

  it("fills missing fields with defaults but honors provided ones", () => {
    const path = join(dir, "config.json");
    writeFileSync(
      path,
      JSON.stringify({ autoSync: { enabled: true, autoMerge: true, commitIntervalSec: 45 } }),
    );
    expect(readAutoSyncConfig(path)).toEqual({
      enabled: true,
      remote: "origin",
      branchPrefix: "cfls/",
      commitIntervalSec: 45,
      fetchIntervalSec: 20,
      autoMerge: true,
    });
  });

  it("ignores invalid field types and falls back to defaults", () => {
    const path = join(dir, "config.json");
    writeFileSync(
      path,
      JSON.stringify({
        autoSync: {
          enabled: "yes", // not a boolean → treated as disabled
          remote: "", // empty → default
          branchPrefix: 123, // wrong type → default
          commitIntervalSec: -5, // non-positive → default
          fetchIntervalSec: 0, // non-positive → default
          autoMerge: "true", // not a boolean → false
        },
      }),
    );
    expect(readAutoSyncConfig(path)).toEqual(DEFAULT_AUTO_SYNC);
  });

  it("only enables when enabled === true (boolean, not truthy)", () => {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ autoSync: { enabled: true } }));
    expect(readAutoSyncConfig(path).enabled).toBe(true);
  });
});
