/**
 * The 13 Local_MCP_Server tools (design §3.4; Req 4.2), wired to the
 * CoordinationAgent exclusively through the {@link AgentPort}.
 *
 * Each tool: validates its arguments with a zod schema (mirroring the §3.4
 * request shapes), delegates to the injected {@link AgentPort}, then wraps the
 * result in the common {@link McpEnvelope} — stamping live connection + staleness
 * on every response (Req 4.7, 33.2). Every response is emitted as both MCP
 * `structuredContent` and a JSON text block so any AI_Agent client can consume it
 * programmatically (Req 4.7). Mutations attempted while offline surface as
 * `OFFLINE_QUEUED` through the port, never as false host acceptance (Req 4.8).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { CoordinationUpdate } from "@cfls/protocol";
import { z } from "zod";

import type { AgentResult, McpEnvelope } from "./envelope";
import { makeEnvelope } from "./envelope";
import type {
  AgentPort,
  DeclareIntentRequest,
  ReleaseLockRequest,
  SessionRef,
  SubscribeData,
} from "./port";

/** The exact set of tool names the Local_MCP_Server exposes (design §3.4; Req 4.2). */
export const TOOL_NAMES = [
  "get_risk_map",
  "get_team_status",
  "get_dependency_impact",
  "get_dependencies",
  "get_dependents",
  "declare_intent",
  "update_intent",
  "withdraw_intent",
  "acquire_lock",
  "release_lock",
  "subscribe_to_coordination_updates",
  "get_connection_status",
  "get_project_session_status",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/**
 * The stable marker carried in MCP `notifications/message` data for a live
 * coordination update. MCP clients can register a standard logging-message
 * handler and narrow on this marker without parsing a human-readable string.
 */
export const COORDINATION_UPDATE_NOTIFICATION_TYPE =
  "cfls.coordination_update" as const;

/** The MCP logging channel used for live coordination-update notifications. */
export const COORDINATION_UPDATE_LOGGER = "cfls.coordination";

/** Structured payload emitted in a standard MCP `notifications/message` event. */
export interface CoordinationUpdateNotificationData {
  type: typeof COORDINATION_UPDATE_NOTIFICATION_TYPE;
  update: CoordinationUpdate;
}

// ---- Shared zod fragments -----------------------------------------------------

const sessionSchema = z.object({
  repoId: z.string(),
  teamId: z.string(),
  branch: z.string(),
  baseRevision: z.string().nullable(),
});

const scopeKindSchema = z.enum(["file", "folder", "glob"]);

/** Serialise an envelope as both structured content and a JSON text block. */
function toToolResult<T>(envelope: McpEnvelope<T>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    structuredContent: envelope as unknown as Record<string, unknown>,
  };
}

/** Stamp connection/staleness and wrap a (possibly async) result in an envelope. */
async function respond<T>(
  port: AgentPort,
  result: AgentResult<T> | Promise<AgentResult<T>>,
): Promise<CallToolResult> {
  const resolved = await result;
  const envelope = makeEnvelope(
    port.getConnection(),
    port.getStaleness(),
    resolved,
  );
  return toToolResult(envelope);
}

/**
 * Register all 13 coordination tools on `server`, delegating to `port`.
 * Returns the same server for chaining.
 */
export function registerTools(server: McpServer, port: AgentPort): McpServer {
  // Keep one stable callback and one agent subscription per Repository_Session.
  // A caller may repeat the MCP tool call after reconnecting or retrying; that
  // must not multiply Local_API subscriptions or repeat every update.
  const subscriptions = new Map<string, Promise<AgentResult<SubscribeData>>>();
  const notifyCoordinationUpdate = (update: CoordinationUpdate): void => {
    const data: CoordinationUpdateNotificationData = {
      type: COORDINATION_UPDATE_NOTIFICATION_TYPE,
      update,
    };
    // `sendLoggingMessage` is the SDK's documented standard MCP
    // `notifications/message` path. A disconnected client must not be able to
    // disrupt the agent's update stream, so notification delivery is best effort.
    void server
      .sendLoggingMessage({
        level: "info",
        logger: COORDINATION_UPDATE_LOGGER,
        data,
      })
      .catch(() => undefined);
  };
  const subscribeOnce = (
    session: SessionRef,
  ): Promise<AgentResult<SubscribeData>> => {
    const key = subscriptionKey(session);
    const existing = subscriptions.get(key);
    if (existing !== undefined) {
      return existing;
    }

    const subscription = Promise.resolve(
      port.subscribeToCoordinationUpdates(
        { session },
        notifyCoordinationUpdate,
      ),
    );
    subscriptions.set(key, subscription);
    void subscription.then(
      (result) => {
        // A failed registration is not durable: a later tool call may retry it.
        if (!result.ok && subscriptions.get(key) === subscription) {
          subscriptions.delete(key);
        }
      },
      () => {
        if (subscriptions.get(key) === subscription) {
          subscriptions.delete(key);
        }
      },
    );
    return subscription;
  };

  // 1. get_risk_map — Req 4.3, 24, 21, 22, 31.5
  server.registerTool(
    "get_risk_map",
    {
      description:
        "Return the machine-readable Risk_Map for a Repository_Session: per-path " +
        "risk levels, contributors, direct/indirect conflicts, and planned file creations.",
      inputSchema: { session: sessionSchema },
    },
    (args) => respond(port, port.getRiskMap({ session: args.session })),
  );

  // 1b. get_team_status — a metadata-only member/activity projection.
  server.registerTool(
    "get_team_status",
    {
      description:
        "Return active team members, their declared tasks, files, locks, and " +
        "editing signals for a Repository_Session. This is coordination metadata, never source content.",
      inputSchema: { session: sessionSchema },
    },
    (args) => respond(port, port.getTeamStatus({ session: args.session })),
  );

  // 2. get_dependency_impact — Req 23.1, 23.4, 23.5
  server.registerTool(
    "get_dependency_impact",
    {
      description:
        "Return metadata-only dependency impact (direct/reverse dependencies, " +
        "shared contracts, risk) for a set of repository-relative paths.",
      inputSchema: { paths: z.array(z.string()) },
    },
    (args) => respond(port, port.getDependencyImpact({ paths: args.paths })),
  );

  // 3. get_dependencies — Req 23.2
  server.registerTool(
    "get_dependencies",
    {
      description: "Return the paths a given path depends on (metadata only).",
      inputSchema: { path: z.string() },
    },
    (args) => respond(port, port.getDependencies({ path: args.path })),
  );

  // 4. get_dependents — Req 23.3
  server.registerTool(
    "get_dependents",
    {
      description:
        "Return the paths that depend on a given path (metadata only).",
      inputSchema: { path: z.string() },
    },
    (args) => respond(port, port.getDependents({ path: args.path })),
  );

  // 5. declare_intent — Req 4.4, 16.1–16.2, 16.5, 16.7
  server.registerTool(
    "declare_intent",
    {
      description:
        "Declare an intent to modify and/or create a set of paths; forwarded to " +
        "the CoordinationHost. Returns the recorded intent id and event revision.",
      inputSchema: {
        session: sessionSchema,
        modifyPaths: z.array(z.string()).default([]),
        createPaths: z.array(z.string()).default([]),
        description: z.string().default(""),
        scopeKind: scopeKindSchema.optional(),
      },
    },
    (args) => {
      const req: DeclareIntentRequest = {
        session: args.session,
        modifyPaths: args.modifyPaths,
        createPaths: args.createPaths,
        description: args.description,
      };
      if (args.scopeKind !== undefined) {
        req.scopeKind = args.scopeKind;
      }
      return respond(port, port.declareIntent(req));
    },
  );

  // 6. update_intent — Req 16.3, 16.8
  server.registerTool(
    "update_intent",
    {
      description:
        "Update an owned Declared_Intent's modify/create paths and description.",
      inputSchema: {
        intentId: z.string(),
        modifyPaths: z.array(z.string()).default([]),
        createPaths: z.array(z.string()).default([]),
        description: z.string().default(""),
      },
    },
    (args) =>
      respond(
        port,
        port.updateIntent({
          intentId: args.intentId,
          modifyPaths: args.modifyPaths,
          createPaths: args.createPaths,
          description: args.description,
        }),
      ),
  );

  // 7. withdraw_intent — Req 16.4, 16.8
  server.registerTool(
    "withdraw_intent",
    {
      description: "Withdraw an owned Declared_Intent.",
      inputSchema: { intentId: z.string() },
    },
    (args) => respond(port, port.withdrawIntent({ intentId: args.intentId })),
  );

  // 8. acquire_lock — Req 12.1–12.4, 32.1, 32.4
  server.registerTool(
    "acquire_lock",
    {
      description:
        "Acquire a coordination lock over a file/folder/glob scope. Reports the " +
        "winner and concurrent-claim status on contention.",
      inputSchema: {
        session: sessionSchema,
        scope: z.string(),
        scopeKind: scopeKindSchema,
      },
    },
    (args) =>
      respond(
        port,
        port.acquireLock({
          session: args.session,
          scope: args.scope,
          scopeKind: args.scopeKind,
        }),
      ),
  );

  // 9. release_lock — Req 12.5–12.8
  server.registerTool(
    "release_lock",
    {
      description: "Release a held lock by lock id or by scope.",
      inputSchema: {
        lockId: z.string().optional(),
        scope: z.string().optional(),
      },
    },
    (args) => {
      const req: ReleaseLockRequest = {};
      if (args.lockId !== undefined) {
        req.lockId = args.lockId;
      }
      if (args.scope !== undefined) {
        req.scope = args.scope;
      }
      return respond(port, port.releaseLock(req));
    },
  );

  // 10. subscribe_to_coordination_updates — Req 25.1, 25.5, 25.6
  server.registerTool(
    "subscribe_to_coordination_updates",
    {
      description:
        "Subscribe to Coordination_Updates for a Repository_Session. Returns a " +
        "subscription id. Each later update is sent as a standard MCP " +
        "notifications/message event with logger 'cfls.coordination' and " +
        "structured data { type: 'cfls.coordination_update', update }.",
      inputSchema: { session: sessionSchema },
    },
    (args) => respond(port, subscribeOnce(args.session)),
  );

  // 11. get_connection_status — Req 4.6, 6.5, 27.4
  server.registerTool(
    "get_connection_status",
    {
      description:
        "Return the current CoordinationHost connectivity and participant lists.",
      inputSchema: {},
    },
    () => respond(port, port.getConnectionStatus()),
  );

  // 12. get_project_session_status — Req 4.6, 10
  server.registerTool(
    "get_project_session_status",
    {
      description:
        "Return the current Repository_Session identity and authorization status.",
      inputSchema: {},
    },
    () => respond(port, port.getProjectSessionStatus()),
  );

  return server;
}

/** A lossless, stable key for deduplicating one subscription per session. */
function subscriptionKey(session: SessionRef): string {
  return JSON.stringify([
    session.repoId,
    session.teamId,
    session.branch,
    session.baseRevision,
  ]);
}
