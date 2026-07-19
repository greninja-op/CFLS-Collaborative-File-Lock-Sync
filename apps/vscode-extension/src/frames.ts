/**
 * Local_API frame protocol as seen from the **client** (the Editor_Extension).
 *
 * The CoordinationAgent's Local_API (see `apps/agent/src/local-api.ts`) speaks a
 * thin newline/JSON frame protocol over the loopback transport: the client first
 * presents its per-session `Local_Auth_Token` in an `auth` frame, then exchanges
 * `request` / `subscribe` frames. This module mirrors exactly those shapes so the
 * extension reuses the agent's wire contract rather than inventing a new one.
 *
 * Client → agent frames: {@link AuthFrame}, {@link RequestFrame},
 * {@link SubscribeFrame}. Agent → client frames: {@link InboundFrame}.
 */

/** A per-session Local_Auth_Token gating every Local_API client (Req 2.5). */
export type LocalAuthToken = string;

/** Client → agent: authenticate the connection before any other frame. */
export interface AuthFrame {
  type: "auth";
  token: LocalAuthToken;
}

/** Client → agent: invoke a tool/query/mutation method (mirrors the MCP tools). */
export interface RequestFrame {
  type: "request";
  id: number;
  method: string;
  params?: unknown;
}

/** Client → agent: register a Coordination_Update subscription for a session. */
export interface SubscribeFrame {
  type: "subscribe";
  id: number;
  params?: unknown;
}

/** Any client → agent frame. */
export type OutboundFrame = AuthFrame | RequestFrame | SubscribeFrame;

/** Agent → client: the auth token was accepted. */
export interface AuthOkFrame {
  type: "auth_ok";
}

/** Agent → client: the auth token was rejected (connection then closes). */
export interface AuthErrorFrame {
  type: "auth_error";
  message?: string;
}

/** Agent → client: the response to a {@link RequestFrame}/{@link SubscribeFrame}. */
export interface ResponseFrame {
  type: "response";
  id: number | null;
  body: unknown;
}

/** Agent → client: a pushed Coordination_Update for an active subscription. */
export interface UpdateFrame {
  type: "update";
  payload: unknown;
}

/** Agent → client: a transport/frame error. */
export interface ErrorFrame {
  type: "error";
  id?: number | null;
  message?: string;
}

/** Any agent → client frame. */
export type InboundFrame =
  | AuthOkFrame
  | AuthErrorFrame
  | ResponseFrame
  | UpdateFrame
  | ErrorFrame;

/** The Local_API method used to carry a periodic extension heartbeat (Req 26.6). */
export const HEARTBEAT_METHOD = "heartbeat";

/** The Local_API method used to forward an Editor_Event to the agent (Req 3.2). */
export const EDITOR_EVENT_METHOD = "editor_event";

/** Parse a raw inbound line into an {@link InboundFrame}, or `null` if malformed. */
export function parseInboundFrame(raw: string): InboundFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const type = (value as { type?: unknown }).type;
  if (typeof type !== "string") {
    return null;
  }
  switch (type) {
    case "auth_ok":
    case "auth_error":
    case "response":
    case "update":
    case "error":
      return value as InboundFrame;
    default:
      return null;
  }
}
