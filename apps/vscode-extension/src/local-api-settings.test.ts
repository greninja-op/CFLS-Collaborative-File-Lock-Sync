/**
 * Unit tests for the pure Local_API settings resolution, including the zero-config
 * auto-discovery of `<workspaceFolder>/.coordination/local-api.json` written by
 * `cfls agent`. The filesystem is injected so no real files are touched.
 */

import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  resolveLocalApiSettings,
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
    exists: (p) => p === path && contents !== null,
    read: (p) => {
      if (p === path && contents !== null) return contents;
      throw new Error("unexpected read");
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
