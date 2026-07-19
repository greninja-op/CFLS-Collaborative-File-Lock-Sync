/**
 * The common {@link McpEnvelope} carried by **every** Local_MCP_Server response
 * (design §3.4; Req 4.7, 33.2) plus the {@link ErrorCode} mapping used to
 * translate the tool schemas' informal error names onto the canonical protocol
 * catalog.
 *
 * Every tool — query or mutation, success or failure — returns its payload
 * wrapped in an `McpEnvelope<T>`:
 *
 *   - `ok` / `data` / `error` — the machine-readable result (Req 4.7).
 *   - `connection` — the live CoordinationHost connectivity (`online`/`offline`),
 *     the configured `hostUrl`, and the last successful sync time (Req 4.7, 6.5).
 *   - `staleness` — whether the served coordination data may be stale, and how
 *     many seconds have elapsed since the last host sync (Req 33.2).
 *
 * The envelope is transport-agnostic: the MCP tool layer serialises it as both
 * `structuredContent` and a JSON text block so an AI_Agent can consume it
 * programmatically regardless of client capabilities.
 */

import type { ErrorCode } from "@cfls/protocol";

/** Live CoordinationHost connectivity reported on every response (Req 4.7, 6.5). */
export interface ConnectionSnapshot {
  /** Whether the local CoordinationAgent currently has a host connection. */
  status: "online" | "offline";
  /** The configured Host_URL the agent connects to (never hardcoded, Req 6.2). */
  hostUrl: string;
  /** ISO-8601 timestamp of the last successful sync, or `null` if never synced. */
  lastSyncAt: string | null;
}

/** Stale/offline indication for served coordination data (Req 33.2, 33.3). */
export interface StalenessSnapshot {
  /** True when the served data may not reflect the authoritative host state. */
  stale: boolean;
  /** Seconds since the last successful host sync, or `null` when never synced. */
  secondsSinceSync: number | null;
}

/** The machine-readable error surface carried by a failed {@link McpEnvelope}. */
export interface EnvelopeError {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

/**
 * The common response envelope for every MCP tool (design §3.4). `data` is
 * present only on success (`ok: true`); `error` only on failure (`ok: false`).
 * `connection` and `staleness` are always present (Req 4.7, 33.2).
 */
export interface McpEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: EnvelopeError;
  connection: ConnectionSnapshot;
  staleness: StalenessSnapshot;
}

/**
 * A tool/agent operation result before it is wrapped in an {@link McpEnvelope}.
 * Success carries typed `data`; failure carries a canonical {@link EnvelopeError}
 * (including `OFFLINE_QUEUED` for mutations attempted while offline, Req 4.8).
 */
export type AgentResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: EnvelopeError };

/**
 * Informal error names used in the design §3.4 tool schemas that are **not**
 * separate {@link ErrorCode}s but aliases of canonical catalog codes (see the
 * reconciliation note in `@cfls/protocol`'s `errors.ts`).
 */
export type ToolErrorAlias = "NOT_AUTHORIZED" | "SESSION_NOT_FOUND" | "OFFLINE";

/**
 * Map a tool-schema error alias onto its canonical {@link ErrorCode}
 * (design §3.4 / `@cfls/protocol` reconciliation note):
 *   - `NOT_AUTHORIZED`    → `AUTH_NOT_AUTHORIZED`
 *   - `SESSION_NOT_FOUND` → `NOT_FOUND`
 *   - `OFFLINE`           → `OFFLINE_QUEUED`
 */
export function mapToolErrorCode(alias: ToolErrorAlias): ErrorCode {
  switch (alias) {
    case "NOT_AUTHORIZED":
      return "AUTH_NOT_AUTHORIZED";
    case "SESSION_NOT_FOUND":
      return "NOT_FOUND";
    case "OFFLINE":
      return "OFFLINE_QUEUED";
  }
}

/**
 * Wrap an {@link AgentResult} in the common {@link McpEnvelope}, stamping the
 * current connection and staleness snapshots so every response carries them
 * (Req 4.7, 33.2). Success sets `data`; failure sets `error`.
 */
export function makeEnvelope<T>(
  connection: ConnectionSnapshot,
  staleness: StalenessSnapshot,
  result: AgentResult<T>,
): McpEnvelope<T> {
  return result.ok
    ? { ok: true, data: result.data, connection, staleness }
    : { ok: false, error: result.error, connection, staleness };
}

/**
 * Build the `OFFLINE_QUEUED` failure result returned when an AI_Agent invokes a
 * state-mutating tool while the CoordinationAgent is in Offline_State (Req 4.8).
 * The message states the mutation was queued and manual coordination is required,
 * never falsely reporting host acceptance.
 */
export function offlineQueuedResult<T>(operation: string): AgentResult<T> {
  return {
    ok: false,
    error: {
      code: "OFFLINE_QUEUED",
      message:
        `The CoordinationAgent is offline; '${operation}' was queued and not ` +
        `accepted by the CoordinationHost. Manual coordination is required until ` +
        `connectivity is restored.`,
    },
  };
}
