/**
 * Host configuration (Req 1.1, 6.1–6.3; design §2.2, §4.1).
 *
 * The CoordinationHost listens at a **configurable `Host_URL`** — there is no
 * hardcoded address or port (Req 6.1). Moving the host from a laptop to a VPS
 * changes only this configuration and the TLS material (design §2.2). All fields
 * are resolved here from an explicit override object first, then environment
 * variables, then safe defaults, so the same binary runs unchanged everywhere.
 */

import type { ExpiryConfigInput } from "@cfls/core-state";

/** TLS material for the WSS listener (Req 6.1, 6.3; design §4.1). */
export interface HostTlsConfig {
  /** Path to a PEM certificate (chain) file. */
  certPath?: string;
  /** Path to the PEM private-key file for {@link certPath}. */
  keyPath?: string;
  /**
   * When true and no cert/key path is supplied, generate an in-memory
   * **development-only** self-signed certificate. NEVER enable in production:
   * clients must skip certificate validation to connect, defeating TLS trust.
   */
  devSelfSigned?: boolean;
}

/** Fully-resolved host configuration. */
export interface HostConfig {
  /** The configured `Host_URL`, e.g. `wss://dev-host.local:8443` (Req 6.1). */
  hostUrl: string;
  /** Bind host parsed from {@link hostUrl}. */
  host: string;
  /** Bind port parsed from {@link hostUrl}. */
  port: number;
  /** TLS material (Req 6.1, 6.3). */
  tls: HostTlsConfig;
  /**
   * Filesystem path to the SQLite database file, or `":memory:"` for an
   * ephemeral store (tests). Durable persistence + restart recovery (Req 1.5,
   * 1.6) require a real file path.
   */
  dbPath: string;
  /** Heartbeat/expiry tuning forwarded to the core-state expiry engine (Req 26). */
  expiry?: ExpiryConfigInput;
  /** Milliseconds the {@link start} call is allowed before failing (Req 1.1). */
  startTimeoutMs: number;
}

/** Caller overrides for {@link loadHostConfig}; every field is optional. */
export interface HostConfigInput {
  hostUrl?: string;
  tls?: HostTlsConfig;
  dbPath?: string;
  expiry?: ExpiryConfigInput;
  startTimeoutMs?: number;
}

/** Default listen deadline: the host must be listening within 10s (Req 1.1). */
export const DEFAULT_START_TIMEOUT_MS = 10_000;

/**
 * Parse a `Host_URL` into its bind host and port. Accepts `wss://host:port`
 * (TLS) and, for local development/tests only, `ws://host:port`. A missing port
 * defaults to 8443 (the conventional WSS coordination port). Throws on a URL
 * that is not a `ws`/`wss` URL so misconfiguration fails fast rather than
 * silently binding the wrong address (Req 6.1).
 */
export function parseHostUrl(hostUrl: string): { host: string; port: number; secure: boolean } {
  let url: URL;
  try {
    url = new URL(hostUrl);
  } catch {
    throw new Error(`Invalid Host_URL: ${hostUrl}`);
  }
  if (url.protocol !== "wss:" && url.protocol !== "ws:") {
    throw new Error(
      `Host_URL must use the ws:// or wss:// scheme (got "${url.protocol}").`,
    );
  }
  const host = url.hostname === "" ? "127.0.0.1" : url.hostname;
  // Port 0 is permitted: it asks the OS for an ephemeral port (used by tests).
  const port = url.port === "" ? 8443 : Number.parseInt(url.port, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Host_URL has an invalid port: ${url.port}`);
  }
  return { host, port, secure: url.protocol === "wss:" };
}

/**
 * Resolve a {@link HostConfig} from explicit overrides, then environment
 * variables, then defaults (Req 6.1). Recognized environment variables:
 *
 *   - `CFLS_HOST_URL`         the `Host_URL` (required if not overridden)
 *   - `CFLS_TLS_CERT`         PEM certificate path
 *   - `CFLS_TLS_KEY`          PEM private-key path
 *   - `CFLS_TLS_DEV_SELF_SIGNED`  `"1"`/`"true"` to use a dev self-signed cert
 *   - `CFLS_DB_PATH`          SQLite database file path
 *
 * There is no built-in default address: an absent `Host_URL` throws so the host
 * never silently listens on a hardcoded address (Req 6.1).
 */
export function loadHostConfig(input: HostConfigInput = {}, env: NodeJS.ProcessEnv = process.env): HostConfig {
  const hostUrl = input.hostUrl ?? env.CFLS_HOST_URL;
  if (hostUrl === undefined || hostUrl.trim() === "") {
    throw new Error(
      "Host_URL is not configured. Set CFLS_HOST_URL or pass { hostUrl } (Req 6.1).",
    );
  }
  const { host, port } = parseHostUrl(hostUrl);

  const tls: HostTlsConfig = input.tls ?? {
    ...(env.CFLS_TLS_CERT !== undefined ? { certPath: env.CFLS_TLS_CERT } : {}),
    ...(env.CFLS_TLS_KEY !== undefined ? { keyPath: env.CFLS_TLS_KEY } : {}),
    devSelfSigned: isTruthy(env.CFLS_TLS_DEV_SELF_SIGNED),
  };

  return {
    hostUrl,
    host,
    port,
    tls,
    dbPath: input.dbPath ?? env.CFLS_DB_PATH ?? ":memory:",
    ...(input.expiry !== undefined ? { expiry: input.expiry } : {}),
    startTimeoutMs: input.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
  };
}

function isTruthy(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}
