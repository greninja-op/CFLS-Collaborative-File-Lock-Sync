/**
 * TLS material resolution for the WSS listener (Req 6.1, 6.3; design §4.1, §8.3).
 *
 * The network channel between agents and the host is TLS everywhere (Req 6.1).
 * In production the operator supplies a real certificate + key (file paths); for
 * laptop-hosted development a self-signed certificate can be generated in memory
 * so the host is reachable over `wss://` without provisioning a CA.
 *
 * SECURITY: a self-signed certificate is a **development-only** convenience.
 * Clients must disable certificate validation to connect to it, which removes
 * the authentication half of TLS's guarantees. Never enable `devSelfSigned` for
 * a real deployment — provision a proper certificate instead.
 */

import { readFileSync } from "node:fs";

import selfsigned from "selfsigned";

import type { HostTlsConfig } from "./config";

/** Resolved PEM material handed to Node's `https`/`tls` server. */
export interface ResolvedTls {
  cert: string;
  key: string;
  /** True when the certificate was self-signed for development (Req 6.1 caveat). */
  selfSigned: boolean;
}

/**
 * Generate an ephemeral, in-memory self-signed certificate for development
 * (design §2.2 laptop host). The certificate is valid for `localhost` and
 * loopback addresses and expires after one day — long enough for a dev session,
 * short enough to discourage reuse.
 */
export async function generateDevCertificate(): Promise<ResolvedTls> {
  const attrs = [{ name: "commonName", value: "localhost" }];
  // `selfsigned.generate` (v5+) resolves asynchronously. Its bundled type
  // overloads are imprecise (they omit `days`), so call through a narrow local
  // signature.
  const generate = selfsigned.generate as unknown as (
    attrs: unknown,
    options: unknown,
  ) => Promise<{ cert: string; private: string }>;
  const pems = await generate(attrs, {
    days: 1,
    keySize: 2048,
    algorithm: "sha256",
    extensions: [
      {
        name: "subjectAltName",
        altNames: [
          { type: 2, value: "localhost" }, // DNS
          { type: 7, ip: "127.0.0.1" }, // IP
          { type: 7, ip: "::1" },
        ],
      },
    ],
  });
  return { cert: pems.cert, key: pems.private, selfSigned: true };
}

/**
 * Resolve TLS material from a {@link HostTlsConfig} (Req 6.1, 6.3):
 *   - a certificate + key path pair are read from disk, or
 *   - a development self-signed certificate is generated when `devSelfSigned`.
 *
 * Throws when neither is available, so the host never falls back to plaintext.
 */
export async function resolveTls(config: HostTlsConfig): Promise<ResolvedTls> {
  if (config.certPath !== undefined && config.keyPath !== undefined) {
    return {
      cert: readFileSync(config.certPath, "utf8"),
      key: readFileSync(config.keyPath, "utf8"),
      selfSigned: false,
    };
  }
  if (config.devSelfSigned === true) {
    return generateDevCertificate();
  }
  throw new Error(
    "No TLS material configured: supply { certPath, keyPath } or enable devSelfSigned (Req 6.1).",
  );
}
