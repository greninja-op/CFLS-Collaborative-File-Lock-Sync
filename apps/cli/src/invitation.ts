/**
 * Invitation (de)serialization for the CLI (Req 5.2, 5.5).
 *
 * The wire form a teammate copies around is `base64(JSON(SignedInvitation))` —
 * exactly the string the {@link CoordinationAgent} expects. The signing itself
 * is done by `@cfls/security`'s {@link issueInvitation}; this module only
 * encodes/decodes and shape-validates so a mistyped invitation fails with a
 * clear message instead of a cryptic handshake error later.
 */

import type { SignedInvitation } from "@cfls/security";

/** Encode a {@link SignedInvitation} to the base64 string teammates exchange. */
export function encodeInvitation(invitation: SignedInvitation): string {
  return Buffer.from(JSON.stringify(invitation), "utf8").toString("base64");
}

/**
 * Decode + shape-validate a base64 invitation string (Req 5.2). Throws a clear
 * error on malformed base64/JSON or a missing `claims`/`signature`, rather than
 * deferring the failure to the host handshake.
 */
export function decodeInvitation(encoded: string): SignedInvitation {
  let json: string;
  try {
    json = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    throw new Error("Invitation is not valid base64.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Invitation does not contain valid JSON.");
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as SignedInvitation).signature !== "string" ||
    typeof (parsed as SignedInvitation).claims !== "object" ||
    (parsed as SignedInvitation).claims === null
  ) {
    throw new Error("Invitation is missing its claims or signature.");
  }

  const claims = (parsed as SignedInvitation).claims;
  if (
    typeof claims.devicePublicKey !== "string" ||
    typeof claims.memberId !== "string" ||
    typeof claims.issuerPublicKey !== "string" ||
    typeof claims.session !== "object" ||
    claims.session === null
  ) {
    throw new Error("Invitation claims are incomplete.");
  }

  return parsed as SignedInvitation;
}
