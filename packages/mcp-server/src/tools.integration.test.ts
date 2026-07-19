/**
 * Integration tests for MCP tool round-trips (task 7.3; Req 4.3–4.6, 4.8, 33.1).
 *
 * Exercises the real `@modelcontextprotocol/sdk` client/server over an in-memory
 * transport, against the core-state-backed {@link CoreStateAgentPort}. Covers
 * query tools, a mutating tool, and an offline-queued mutation end-to-end,
 * asserting the common {@link McpEnvelope} is returned on every response.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { DependencyGraph, MemberRef, SessionId } from "@cfls/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { McpEnvelope } from "./envelope";
import { CoreStateAgentPort } from "./fake-agent";
import { createMcpServer } from "./server";
import { TOOL_NAMES } from "./tools";

const session: SessionId = {
  repoId: "repo-1",
  teamId: "team-1",
  branch: "main",
  baseRevision: "base-9",
};
const self: MemberRef = { memberId: "u-1", deviceId: "d-1" };

// A tiny metadata-only dependency graph: routes.ts -> api.ts -> db.ts.
const graph: DependencyGraph = {
  snapshot: {
    sessionId: session,
    graphVersion: 1,
    analyzerVersion: "test",
  },
  packages: [],
  modules: [
    {
      sourceFile: "src/routes.ts",
      edges: [
        { from: "src/routes.ts", to: "src/api.ts", kind: "runtime_import", confidence: "high" },
      ],
    },
    {
      sourceFile: "src/api.ts",
      edges: [
        { from: "src/api.ts", to: "src/db.ts", kind: "runtime_import", confidence: "high" },
      ],
    },
  ],
  contracts: [],
};

interface Harness {
  client: Client;
  agent: CoreStateAgentPort;
  call: <T>(name: string, args: Record<string, unknown>) => Promise<McpEnvelope<T>>;
  close: () => Promise<void>;
}

async function connectHarness(online = true): Promise<Harness> {
  const agent = new CoreStateAgentPort({ session, self, online, graph });
  const server = createMcpServer(agent);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);

  const call = async <T>(
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpEnvelope<T>> => {
    const result = await client.callTool({ name, arguments: args });
    return result.structuredContent as unknown as McpEnvelope<T>;
  };

  return {
    client,
    agent,
    call,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("MCP tool round-trips over the SDK in-memory transport", () => {
  let harness: Harness;

  afterEach(async () => {
    await harness.close();
  });

  it("exposes exactly the 12 named tools (Req 4.2)", async () => {
    harness = await connectHarness();
    const listed = await harness.client.listTools();
    const names = listed.tools.map((t) => t.name).sort();
    expect(names).toEqual([...TOOL_NAMES].sort());
  });

  it("get_project_session_status returns the session identity + envelope (Req 4.6)", async () => {
    harness = await connectHarness();
    const env = await harness.call<{
      session: { repoId: string; branch: string };
      authorized: boolean;
    }>("get_project_session_status", {});

    expect(env.ok).toBe(true);
    expect(env.data?.session.repoId).toBe("repo-1");
    expect(env.data?.session.branch).toBe("main");
    expect(env.data?.authorized).toBe(true);
    // Every response carries connection + staleness (Req 4.7, 33.2).
    expect(env.connection.status).toBe("online");
    expect(env.staleness.stale).toBe(false);
  });

  it("get_connection_status reports connectivity + participants (Req 4.6)", async () => {
    harness = await connectHarness();
    const env = await harness.call<{
      status: string;
      manualCoordinationRequired: boolean;
    }>("get_connection_status", {});
    expect(env.ok).toBe(true);
    expect(env.data?.status).toBe("online");
    expect(env.data?.manualCoordinationRequired).toBe(false);
  });

  it("get_dependencies / get_dependents return metadata-only edges (Req 4.5)", async () => {
    harness = await connectHarness();

    const deps = await harness.call<{ dependsOn: string[]; presentInGraph: boolean }>(
      "get_dependencies",
      { path: "src/api.ts" },
    );
    expect(deps.ok).toBe(true);
    expect(deps.data?.presentInGraph).toBe(true);
    expect(deps.data?.dependsOn).toEqual(["src/db.ts"]);

    const dependents = await harness.call<{ dependedOnBy: string[] }>(
      "get_dependents",
      { path: "src/api.ts" },
    );
    expect(dependents.data?.dependedOnBy).toEqual(["src/routes.ts"]);
  });

  it("get_dependency_impact returns an empty result for a path absent from the graph (Req 23.5)", async () => {
    harness = await connectHarness();
    const env = await harness.call<{
      impacts: { path: string; presentInGraph: boolean; directDependencies: string[] }[];
    }>("get_dependency_impact", { paths: ["src/unknown.ts"] });
    expect(env.ok).toBe(true);
    const impact = env.data?.impacts[0];
    expect(impact?.presentInGraph).toBe(false);
    expect(impact?.directDependencies).toEqual([]);
  });

  it("get_risk_map returns a machine-readable Risk_Map envelope (Req 4.3)", async () => {
    harness = await connectHarness();
    const env = await harness.call<{
      paths: unknown[];
      plannedFileCreations: unknown[];
      highestRevision: number;
    }>("get_risk_map", { session });
    expect(env.ok).toBe(true);
    expect(Array.isArray(env.data?.paths)).toBe(true);
    expect(Array.isArray(env.data?.plannedFileCreations)).toBe(true);
  });

  it("acquire_lock (mutating tool) is granted and assigns an event revision (Req 12.1)", async () => {
    harness = await connectHarness();
    const env = await harness.call<{
      granted: boolean;
      lockId?: string;
      eventRevision: number;
    }>("acquire_lock", { session, scope: "src/api.ts", scopeKind: "file" });

    expect(env.ok).toBe(true);
    expect(env.data?.granted).toBe(true);
    expect(typeof env.data?.lockId).toBe("string");
    expect(env.data?.eventRevision).toBe(1);
  });

  it("declare_intent round-trips and echoes the recorded intent (Req 4.4)", async () => {
    harness = await connectHarness();
    const env = await harness.call<{ intentId: string; eventRevision: number }>(
      "declare_intent",
      {
        session,
        modifyPaths: ["src/api.ts"],
        createPaths: [],
        description: "refactor api",
      },
    );
    expect(env.ok).toBe(true);
    expect(env.data?.intentId).toMatch(/^int-/);
    expect(env.data?.eventRevision).toBeGreaterThan(0);
  });

  it("an offline mutation returns OFFLINE_QUEUED without host acceptance (Req 4.8, 33.1)", async () => {
    harness = await connectHarness(false);
    const env = await harness.call<unknown>("declare_intent", {
      session,
      modifyPaths: ["src/api.ts"],
      createPaths: [],
      description: "while offline",
    });

    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe("OFFLINE_QUEUED");
    // Connectivity/staleness still reported on the failed response.
    expect(env.connection.status).toBe("offline");
    expect(env.staleness.stale).toBe(true);
  });

  it("queries still succeed while offline, serving stale data (Req 33.1)", async () => {
    harness = await connectHarness(false);
    const env = await harness.call<{ dependsOn: string[] }>("get_dependencies", {
      path: "src/api.ts",
    });
    expect(env.ok).toBe(true);
    expect(env.data?.dependsOn).toEqual(["src/db.ts"]);
    expect(env.connection.status).toBe("offline");
    expect(env.staleness.stale).toBe(true);
  });

  it("subscribe_to_coordination_updates returns a subscription id (Req 25.1)", async () => {
    harness = await connectHarness();
    const env = await harness.call<{ subscriptionId: string }>(
      "subscribe_to_coordination_updates",
      { session },
    );
    expect(env.ok).toBe(true);
    expect(env.data?.subscriptionId).toMatch(/^sub-/);
  });
});
