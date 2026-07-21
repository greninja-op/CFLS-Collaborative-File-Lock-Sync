import { describe, expect, it } from "vitest";

import {
  DEFAULT_LOCAL_API_PORT,
  parseDashboardEnv,
  parseLocalApiPort,
  serviceAgentArgs,
  startAndPublishLocalApi,
  type LocalApiPublishingAgent,
} from "./index";

describe("Local_API CLI startup", () => {
  it("honors the optional dashboard environment switch for hosted deployments", () => {
    expect(parseDashboardEnv(undefined)).toBeUndefined();
    expect(parseDashboardEnv("1")).toBe(true);
    expect(parseDashboardEnv("true")).toBe(true);
    expect(parseDashboardEnv("TRUE")).toBe(true);
    expect(parseDashboardEnv("0")).toBe(false);
    expect(parseDashboardEnv("false")).toBe(false);
  });

  it("accepts only real TCP ports and rejects invalid values before startup", () => {
    expect(parseLocalApiPort(undefined)).toBe(DEFAULT_LOCAL_API_PORT);
    expect(parseLocalApiPort("1")).toBe(1);
    expect(parseLocalApiPort("65535")).toBe(65_535);

    for (const invalid of [true, "", "0", "65536", "-1", "8750junk"]) {
      expect(() => parseLocalApiPort(invalid)).toThrow(
        "--local-port must be an integer from 1 through 65535.",
      );
    }
  });

  it("validates a service agent port before installing it into the background argv", () => {
    const args = (localPort: string | boolean | undefined) => ({
      positionals: [],
      options: localPort === undefined ? {} : { "local-port": localPort },
    });

    expect(serviceAgentArgs(args("00123"))).toContain("123");
    expect(() => serviceAgentArgs(args("70000"))).toThrow(
      "--local-port must be an integer from 1 through 65535.",
    );
    expect(() => serviceAgentArgs(args(true))).toThrow(
      "--local-port must be an integer from 1 through 65535.",
    );
  });

  it("publishes discovery only after the Local_API reports its bound address", async () => {
    const events: string[] = [];
    const agent: LocalApiPublishingAgent = {
      start: async () => {
        events.push("started");
        return { localApiAddress: { wsUrl: "ws://127.0.0.1:49321" } };
      },
      stop: async () => {
        events.push("stopped");
      },
    };

    await expect(
      startAndPublishLocalApi(
        agent,
        "/workspace/.coordination/local-api.json",
        "token",
        (path, record) => {
          expect(events).toEqual(["started"]);
          expect(path).toBe("/workspace/.coordination/local-api.json");
          expect(record).toEqual({
            url: "ws://127.0.0.1:49321",
            token: "token",
          });
          events.push("published");
        },
      ),
    ).resolves.toBe("ws://127.0.0.1:49321");
    expect(events).toEqual(["started", "published"]);
  });

  it("never publishes discovery when the Local_API cannot start", async () => {
    let published = false;
    let stopped = false;
    const agent: LocalApiPublishingAgent = {
      start: async () => {
        throw new Error("EADDRINUSE");
      },
      stop: async () => {
        stopped = true;
      },
    };

    await expect(
      startAndPublishLocalApi(
        agent,
        "/workspace/local-api.json",
        "token",
        () => {
          published = true;
        },
      ),
    ).rejects.toThrow("EADDRINUSE");
    expect(published).toBe(false);
    expect(stopped).toBe(true);
  });

  it("stops the running agent if secure discovery publication fails", async () => {
    let stopped = false;
    const agent: LocalApiPublishingAgent = {
      start: async () => ({
        localApiAddress: { wsUrl: "ws://127.0.0.1:49322" },
      }),
      stop: async () => {
        stopped = true;
      },
    };

    await expect(
      startAndPublishLocalApi(
        agent,
        "/workspace/local-api.json",
        "token",
        () => {
          throw new Error("private ACL unavailable");
        },
      ),
    ).rejects.toThrow("private ACL unavailable");
    expect(stopped).toBe(true);
  });
});
