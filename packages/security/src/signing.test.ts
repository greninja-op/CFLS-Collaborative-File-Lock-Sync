/**
 * Unit tests for Ed25519 device identity and canonical-envelope signing
 * (Req 5.1, 7.1, 7.2; design §8.2, §8.3).
 */

import { buildEnvelope, type EventEnvelope } from "@cfls/protocol";
import { describe, expect, it } from "vitest";

import {
  deriveDeviceId,
  deriveKeyId,
  generateDeviceKey,
  privateKeyObject,
  publicKeyObject,
} from "./keys";
import { signEnvelope, verifySignedEvent } from "./signing";

/** A representative, fully-populated envelope to sign. */
function sampleEnvelope(deviceId = "dev-abc"): EventEnvelope {
  return buildEnvelope({
    type: "presence.report",
    eventId: "evt-1",
    session: {
      repoId: "repo-1",
      teamId: "team-1",
      branch: "main",
      baseRevision: null,
    },
    deviceId,
    replay: { counter: 1, nonce: "bm9uY2U=" },
    payload: { path: "src/index.ts", state: "editing" },
    sentAt: "2024-01-01T10:00:00Z",
  });
}

describe("generateDeviceKey", () => {
  it("produces distinct 32-byte raw base64 key pairs (Req 5.1)", () => {
    const a = generateDeviceKey();
    const b = generateDeviceKey();

    expect(Buffer.from(a.publicKey, "base64")).toHaveLength(32);
    expect(Buffer.from(a.privateKey, "base64")).toHaveLength(32);
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.privateKey).not.toBe(b.privateKey);
  });

  it("round-trips into importable Node KeyObjects", () => {
    const key = generateDeviceKey();
    expect(publicKeyObject(key.publicKey).asymmetricKeyType).toBe("ed25519");
    expect(privateKeyObject(key.privateKey).asymmetricKeyType).toBe("ed25519");
  });
});

describe("deriveKeyId / deriveDeviceId", () => {
  it("is deterministic for a given public key and collision-resistant across keys", () => {
    const a = generateDeviceKey();
    const b = generateDeviceKey();

    expect(deriveKeyId(a.publicKey)).toBe(deriveKeyId(a.publicKey));
    expect(deriveDeviceId(a.publicKey)).toBe(deriveKeyId(a.publicKey));
    expect(deriveKeyId(a.publicKey)).not.toBe(deriveKeyId(b.publicKey));
  });
});

describe("signEnvelope / verifySignedEvent", () => {
  it("verifies a signature produced with the matching private key (Req 7.1, 7.2)", () => {
    const key = generateDeviceKey();
    const signed = signEnvelope(sampleEnvelope(), key.privateKey);

    expect(signed.envelope).toEqual(sampleEnvelope());
    expect(Buffer.from(signed.signature, "base64").length).toBeGreaterThan(0);
    expect(verifySignedEvent(signed, key.publicKey)).toBe(true);
  });

  it("rejects a signature checked against a different public key (Req 7.2)", () => {
    const signer = generateDeviceKey();
    const other = generateDeviceKey();
    const signed = signEnvelope(sampleEnvelope(), signer.privateKey);

    expect(verifySignedEvent(signed, other.publicKey)).toBe(false);
  });

  it("rejects a tampered envelope even with a valid-looking signature (Req 7.2)", () => {
    const key = generateDeviceKey();
    const signed = signEnvelope(sampleEnvelope(), key.privateKey);

    const tampered = {
      ...signed,
      envelope: {
        ...signed.envelope,
        payload: { path: "src/other.ts", state: "editing" },
      },
    };

    expect(verifySignedEvent(tampered, key.publicKey)).toBe(false);
  });

  it("returns false rather than throwing on a malformed signature", () => {
    const key = generateDeviceKey();
    const signed = signEnvelope(sampleEnvelope(), key.privateKey);

    expect(
      verifySignedEvent(
        { ...signed, signature: "!!!not-base64!!!" },
        key.publicKey,
      ),
    ).toBe(false);
  });

  it("is insensitive to envelope key ordering via canonicalization", () => {
    const key = generateDeviceKey();
    const original = sampleEnvelope();
    const signed = signEnvelope(original, key.privateKey);

    // Reconstruct the envelope with keys inserted in a different order.
    const reordered: EventEnvelope = {
      payload: original.payload,
      sentAt: original.sentAt,
      replay: original.replay,
      deviceId: original.deviceId,
      session: original.session,
      eventId: original.eventId,
      version: original.version,
      type: original.type,
    };

    expect(
      verifySignedEvent({ ...signed, envelope: reordered }, key.publicKey),
    ).toBe(true);
  });
});
