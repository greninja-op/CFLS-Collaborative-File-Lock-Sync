/**
 * Round-trip tests for the CLI config files (host.json, agent.json,
 * local-api.json). Every write must read back exactly, keys must dedupe, and
 * partial agent-config updates must merge rather than clobber.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendAdminPublicKey,
  readAgentConfig,
  readHostConfig,
  readLocalApiConfig,
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
