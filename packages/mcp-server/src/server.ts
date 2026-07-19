/**
 * Local_MCP_Server scaffold (design §3.4; Req 4.1).
 *
 * Builds an `@modelcontextprotocol/sdk` {@link McpServer} — the strictly-local
 * MCP surface embedded beside the CoordinationAgent — and registers the 12
 * coordination tools wired to the injected {@link AgentPort}. The server is
 * transport-agnostic: callers connect it to a stdio transport in production
 * (`StdioServerTransport`) or an in-memory transport in tests. It never speaks to
 * the CoordinationHost directly; all coordination flows through the agent port
 * (Req 4.1).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AgentPort } from "./port";
import { registerTools } from "./tools";

/** Default MCP server identity advertised to connecting clients. */
export const MCP_SERVER_INFO = {
  name: "cfls-local-mcp-server",
  version: "0.0.0",
} as const;

/** Options for {@link createMcpServer}. */
export interface CreateMcpServerOptions {
  /** Override the advertised server name. */
  name?: string;
  /** Override the advertised server version. */
  version?: string;
}

/**
 * Create the Local_MCP_Server with all 12 tools registered against `port`.
 * The returned server must be `connect()`ed to a transport by the caller.
 */
export function createMcpServer(
  port: AgentPort,
  options: CreateMcpServerOptions = {},
): McpServer {
  const server = new McpServer({
    name: options.name ?? MCP_SERVER_INFO.name,
    version: options.version ?? MCP_SERVER_INFO.version,
  });
  registerTools(server, port);
  return server;
}
