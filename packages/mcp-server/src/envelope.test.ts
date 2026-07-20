/**
 * Unit tests for the common {@link McpEnvelope}, the {@link ErrorCode} mapping,
 * and the `OFFLINE_QUEUED` result helper (task 7.4; Req 4.7, 4.8, 33.2).
 */

import { isErrorCode } from "@cfls/protocol";
import { describe, expect, it } from "vitest";

import type {
  AgentResult,
  ConnectionSnapshot,
  StalenessSnapshot,
} from "./envelope";
import {
  makeEnvelope,
  mapToolErrorCode,
  offlineQueuedResult,
} from "./envelope";

const online: ConnectionSnapshot = {
  status: "online",
  hostUrl: "wss://host.example:8443",
  lastSyncAt: "2024-01-01T00:00:00.000Z",
};

const fresh: StalenessSnapshot = { stale: false, secondsSinceSync: 3 };

describe("makeEnvelope", () => {
  it("carries connection and staleness on a success response (Req 4.7, 33.2)", () => {
    const result: AgentResult<{ value: number }> = {
      ok: true,
      data: { value: 42 },
    };

    const envelope = makeEnvelope(online, fresh, result);

    expect(envelope.ok).toBe(true);
    expect(envelope.data).toEqual({ value: 42 });
    expect(envelope.error).toBeUndefined();
    // Connectivity + staleness always present.
    expect(envelope.connection).toEqual(online);
    expect(envelope.staleness).toEqual(fresh);
  });

  it("carries connection and staleness on a failure response, with no data", () => {
    const offline: ConnectionSnapshot = {
      status: "offline",
      hostUrl: online.hostUrl,
      lastSyncAt: online.lastSyncAt,
    };
    const stale: StalenessSnapshot = { stale: true, secondsSinceSync: 90 };
    const result: AgentResult<never> = {
      ok: false,
      error: { code: "NOT_FOUND", message: "nope" },
    };

    const envelope = makeEnvelope(offline, stale, result);

    expect(envelope.ok).toBe(false);
    expect(envelope.data).toBeUndefined();
    expect(envelope.error).toEqual({ code: "NOT_FOUND", message: "nope" });
    expect(envelope.connection.status).toBe("offline");
    expect(envelope.staleness.stale).toBe(true);
    expect(envelope.staleness.secondsSinceSync).toBe(90);
  });

  it("reports null lastSyncAt / secondsSinceSync when never synced", () => {
    const neverSynced: ConnectionSnapshot = {
      status: "offline",
      hostUrl: online.hostUrl,
      lastSyncAt: null,
    };
    const envelope = makeEnvelope(
      neverSynced,
      { stale: true, secondsSinceSync: null },
      { ok: true, data: {} },
    );
    expect(envelope.connection.lastSyncAt).toBeNull();
    expect(envelope.staleness.secondsSinceSync).toBeNull();
  });
});

describe("mapToolErrorCode", () => {
  it("maps the design §3.4 informal error aliases onto canonical ErrorCodes", () => {
    expect(mapToolErrorCode("NOT_AUTHORIZED")).toBe("AUTH_NOT_AUTHORIZED");
    expect(mapToolErrorCode("SESSION_NOT_FOUND")).toBe("NOT_FOUND");
    expect(mapToolErrorCode("OFFLINE")).toBe("OFFLINE_QUEUED");
  });

  it("only ever produces valid protocol error codes", () => {
    for (const alias of [
      "NOT_AUTHORIZED",
      "SESSION_NOT_FOUND",
      "OFFLINE",
    ] as const) {
      expect(isErrorCode(mapToolErrorCode(alias))).toBe(true);
    }
  });
});

describe("offlineQueuedResult", () => {
  it("returns an OFFLINE_QUEUED failure without falsely reporting host acceptance (Req 4.8)", () => {
    const result = offlineQueuedResult("acquire_lock");

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected failure");
    }
    expect(result.error.code).toBe("OFFLINE_QUEUED");
    expect(isErrorCode(result.error.code)).toBe(true);
    // Message must name the operation, say it was queued, and require manual coordination.
    expect(result.error.message).toContain("acquire_lock");
    expect(result.error.message.toLowerCase()).toContain("queued");
    expect(result.error.message.toLowerCase()).toContain("manual coordination");
    // Must NOT falsely claim host acceptance.
    expect(result.error.message.toLowerCase()).not.toMatch(/\bwas accepted\b/);
    expect(result.error.message.toLowerCase()).not.toMatch(
      /successfully accepted/,
    );
  });
});
