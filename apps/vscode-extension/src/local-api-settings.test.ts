/**
 * Unit tests for the pure Local_API settings resolution, including the zero-config
 * auto-discovery of `<workspaceFolder>/.coordination/local-api.json` written by
 * `cfls agent`. The filesystem is injected so no real files are touched.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  readPrivateLocalApiDiscovery,
  resolveLocalApiSettings,
  type LocalApiDiscoverySecurity,
  type LocalApiFileReader,
  type RawLocalApiConfig,
} from "./local-api-settings";

const raw: RawLocalApiConfig = {
  url: "ws://127.0.0.1:8750",
  token: "",
  heartbeatIntervalMs: 10_000,
};

/** Build a reader that serves a single discovery file. */
function readerWith(path: string, contents: string | null): LocalApiFileReader {
  return {
    readPrivateDiscovery: (p) => {
      if (p === path && contents !== null) return contents;
      return null;
    },
  };
}

describe("resolveLocalApiSettings", () => {
  const wf = join("work", "repo");
  const discoveryPath = join(wf, ".coordination", "local-api.json");

  it("auto-discovers url + token from local-api.json when no token is configured", () => {
    const reader = readerWith(
      discoveryPath,
      JSON.stringify({ url: "ws://127.0.0.1:8751", token: "discovered-token" }),
    );
    const settings = resolveLocalApiSettings(raw, wf, reader);
    expect(settings).toEqual({
      url: "ws://127.0.0.1:8751",
      token: "discovered-token",
      heartbeatIntervalMs: 10_000,
    });
  });

  it("keeps an explicitly configured token (discovery is not consulted)", () => {
    const configured: RawLocalApiConfig = { ...raw, token: "manual-token" };
    const reader = readerWith(
      discoveryPath,
      JSON.stringify({ url: "x", token: "y" }),
    );
    const settings = resolveLocalApiSettings(configured, wf, reader);
    expect(settings.token).toBe("manual-token");
    expect(settings.url).toBe(raw.url);
  });

  it("falls back to configured values when the discovery file is absent", () => {
    const reader = readerWith(discoveryPath, null);
    expect(resolveLocalApiSettings(raw, wf, reader)).toEqual({ ...raw });
  });

  it("falls back to configured values when the discovery file is malformed", () => {
    const reader = readerWith(discoveryPath, "{ not json");
    expect(resolveLocalApiSettings(raw, wf, reader)).toEqual({ ...raw });
  });

  it("returns configured values unchanged when there is no workspace folder", () => {
    const reader = readerWith(
      discoveryPath,
      JSON.stringify({ url: "x", token: "y" }),
    );
    expect(resolveLocalApiSettings(raw, undefined, reader)).toEqual({ ...raw });
  });
});

describe("readPrivateLocalApiDiscovery", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cfls-vscode-local-api-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a Windows discovery file when the current-user ACL cannot be verified", () => {
    const path = join(dir, "local-api.json");
    writeFileSync(
      path,
      JSON.stringify({ url: "ws://127.0.0.1:8751", token: "untrusted" }),
    );
    let checks = 0;
    const security: LocalApiDiscoverySecurity = {
      platform: "win32",
      verifyWindowsFile: () => {
        checks += 1;
        return false;
      },
    };

    expect(readPrivateLocalApiDiscovery(path, security)).toBeNull();
    expect(checks).toBe(1);
  });

  it("reads a mocked Windows discovery file only after two ACL checks", () => {
    const path = join(dir, "local-api.json");
    const contents = JSON.stringify({
      url: "ws://127.0.0.1:8751",
      token: "trusted",
    });
    writeFileSync(path, contents);
    let checks = 0;
    const security: LocalApiDiscoverySecurity = {
      platform: "win32",
      verifyWindowsFile: () => {
        checks += 1;
        return true;
      },
    };

    expect(readPrivateLocalApiDiscovery(path, security)).toBe(contents);
    expect(checks).toBe(2);
  });
});
