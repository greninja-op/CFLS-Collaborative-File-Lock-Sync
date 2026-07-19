/**
 * The invite → connect flow, exercised end-to-end with the REAL `@cfls/security`
 * primitives (Req 5.2, 5.5). We generate an admin key, sign an invitation for a
 * teammate device, encode it as the base64 string the teammate pastes, decode
 * it, and verify it validates against the admin key — exactly the checks the
 * host performs at handshake time.
 */

import { describe, expect, it } from "vitest";

import {
  generateDeviceKey,
  issueInvitation,
  validateInvitation,
} from "@cfls/security";
import type { SessionId } from "@cfls/protocol";

import { decodeInvitation, encodeInvitation } from "./invitation";

const session: SessionId = {
  repoId: "github.com/acme/app",
  teamId: "team-1",
  branch: "main",
  baseRevision: "abc123",
};

describe("invite → connect flow", () => {
  it("signs, encodes, decodes, and validates an invitation", () => {
    const admin = generateDeviceKey();
    const teammate = generateDeviceKey();

    const signed = issueInvitation(
      {
        session,
        devicePublicKey: teammate.publicKey,
        memberId: "bob",
        issuerPublicKey: admin.publicKey,
      },
      admin.privateKey,
    );

    // Admin side: encode to the string the teammate receives.
    const encoded = encodeInvitation(signed);
    expect(typeof encoded).toBe("string");

    // Teammate side (`cfls connect`): decode + shape-validate.
    const decoded = decodeInvitation(encoded);
    expect(decoded.claims.memberId).toBe("bob");
    expect(decoded.claims.session).toEqual(session);
    expect(decoded.claims.devicePublicKey).toBe(teammate.publicKey);

    // Host side: the invitation validates against the authorized admin key.
    expect(validateInvitation(decoded, [admin.publicKey]).valid).toBe(true);

    // A different (non-admin) issuer key is rejected.
    const stranger = generateDeviceKey();
    const result = validateInvitation(decoded, [stranger.publicKey]);
    expect(result.valid).toBe(false);
  });

  it("rejects malformed invitation strings with a clear error", () => {
    expect(() => decodeInvitation("not-base64-json!!")).toThrow();
    expect(() => decodeInvitation(Buffer.from("{}", "utf8").toString("base64"))).toThrow(
      /claims or signature/,
    );
  });
});
