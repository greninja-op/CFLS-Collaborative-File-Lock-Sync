/**
 * Protocol error codes — the single, authoritative catalog shared by host,
 * agent, mcp-server, and extension.
 *
 * Mirrors design.md §11.1 "Error code catalog". These are the typed `error.code`
 * values returned in `error {code, message, refEventId?}` messages (host → client),
 * in `auth.error`, and in the `McpEnvelope.error` surface.
 *
 * Reconciliation note (see task 2.2 / design §3.4 tool schemas): the MCP tool
 * schemas informally reference `NOT_AUTHORIZED`, `SESSION_NOT_FOUND`, and `OFFLINE`.
 * These map onto the canonical §11.1 codes as follows and are NOT separate codes:
 *   - `NOT_AUTHORIZED`   → {@link ErrorCode} `'AUTH_NOT_AUTHORIZED'`
 *   - `SESSION_NOT_FOUND`→ {@link ErrorCode} `'NOT_FOUND'`
 *   - `OFFLINE`          → surfaced via connection/staleness envelopes; a mutation
 *                          attempted while offline yields `'OFFLINE_QUEUED'` (Req 4.8).
 */

/** The canonical protocol error-code union (design §11.1). */
export type ErrorCode =
  /** Unknown/revoked device key or bad invitation (Req 5.4). */
  | "AUTH_INVALID_DEVICE"
  /** Invitation not signed by an authorized admin (Req 5.5). */
  | "AUTH_ISSUER_NOT_ADMIN"
  /** Event targeted an unauthorized session (Req 10.7). */
  | "AUTH_SESSION_FORBIDDEN"
  /** Generic authorization failure (Req 25.6, 16.6). */
  | "AUTH_NOT_AUTHORIZED"
  /** Schema/version/glob/oversize/content violation (Req 7.6, 16.7, 29.5, 32.4). */
  | "FORMAT_ERROR"
  /** Update/withdraw of an intent the caller does not own (Req 16.8). */
  | "NOT_OWNER"
  /** Release attempted by a non-holder (Req 12.7). */
  | "NOT_LOCK_HOLDER"
  /** Release attempted with no active lock (Req 12.8). */
  | "NO_ACTIVE_LOCK"
  /** Unknown intent / lock / session. */
  | "NOT_FOUND"
  /** Coordination-required override supplied without a reason (Req 13.4). */
  | "OVERRIDE_REASON_REQUIRED"
  /** Mutation queued while the agent is offline (Req 4.8). */
  | "OFFLINE_QUEUED"
  /** Persistence failure. */
  | "STORAGE_ERROR"
  /** OS credential store missing/unusable (Req 5.9). */
  | "SECURE_STORAGE_UNAVAILABLE";

/**
 * Runtime list of every {@link ErrorCode}, in the same order as design §11.1.
 * Kept in lockstep with the union above (the {@link ErrorCode} annotation forces
 * a compile error if the two ever drift).
 */
export const ERROR_CODES: readonly ErrorCode[] = [
  "AUTH_INVALID_DEVICE",
  "AUTH_ISSUER_NOT_ADMIN",
  "AUTH_SESSION_FORBIDDEN",
  "AUTH_NOT_AUTHORIZED",
  "FORMAT_ERROR",
  "NOT_OWNER",
  "NOT_LOCK_HOLDER",
  "NO_ACTIVE_LOCK",
  "NOT_FOUND",
  "OVERRIDE_REASON_REQUIRED",
  "OFFLINE_QUEUED",
  "STORAGE_ERROR",
  "SECURE_STORAGE_UNAVAILABLE",
] as const;

const ERROR_CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES);

/** Narrowing type guard: is `value` a known {@link ErrorCode}? */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && ERROR_CODE_SET.has(value);
}

/**
 * The shape carried by an `error` message (host → client) and by `auth.error`.
 * `refEventId` links the error back to the offending `Event_ID` where applicable.
 */
export interface ProtocolError {
  code: ErrorCode;
  message: string;
  refEventId?: string;
}
