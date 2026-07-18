/**
 * Consolidated device-lifecycle unit tests (Req 5.1, 5.2, 5.5, 5.6, 5.7; design
 * §8.2, §8.3). These tie the individually-unit-tested primitives — keygen,
 * envelope signing/verification, invitation issuance/validation, admission,
 * revocation, and rotation — into the end-to-end flow the host relies on, and
 * assert the *authorization-layer* consequences that no single-function test
 * covers: a device's events must only be honoured while its key is both
 * cryptographically valid AND admitted (present, invitation-valid, not revoked).
 *
 * The granular behaviours (tampered signatures, non-admin issuer codes, expiry,
 * upsert semantics, non-mutation) live in `signing.test.ts` and
 * `invitations.test.ts`; this file intentionally does not repeat them.
 */

import { buildEnvelope, type EventEnvelope, type SessionId } from "@cfls/protocol";
import { describe, expect, it } from "vitest";

import { generateDeviceKey } from "./keys";
import { signEnvelope, verifySignedEvent } from "./signing";
import {
  admitDevice,
  canAuthenticate,
  issueInvitation,
  revokeDevice,
  rotateDeviceKey,
  type MembershipRegistry,
  type SignedInvitation,
} from "./invitations";

const SESSION: SessionId = {
  repoId: "repo-1",
  teamId: "team-1",
  branch: "main",
  baseRevision: null,
};

/** A representative presence envelope authored by `deviceId`. */
function envelopeFrom(deviceId: string): EventEnvelope {
  return buildEnvelope({
    type: "presence.report",
    eventId: `evt-${deviceId}`,
    session: SESSION,
    deviceId,
    replay: { counter: 1, nonce: "bm9uY2U=" },
    payload: { path: "src/index.ts", state: "editing" },
    sentAt: "2024-01-01T10:00:00Z",
  });
}

/** Issue a valid invitation for `device` signed by `admin`. */
function invite(
  admin: ReturnType<typeof generateDeviceKey>,
  device: ReturnType<typeof generateDeviceKey>,
  memberId = "member-1",
): SignedInvitation {
  return issueInvitation(
    {
      session: SESSION,
      devicePublicKey: device.publicKey,
      memberId,
      issuerPublicKey: admin.publicKey,
    },
    admin.privateKey,
  );
}

/**
 * The host's admission-time gate for an event: the signing key must both verify
 * the event cryptographically AND be authorised in the registry (Req 5.4, 5.6).
 */
function eventAccepted(
  registry: MembershipRegistry,
  signerPublicKey: string,
  signed: ReturnType<typeof signEnvelope>,
): boolean {
  return (
    canAuthenticate(registry, signerPublicKey) &&
    verifySignedEvent(signed, signerPublicKey)
  );
}

describe("device lifecycle: keygen → sign → invite → admit → rotate → revoke", () => {
  it("admits a device via a valid invitation and then honours its signed events (Req 5.1, 5.2)", () => {
    const admin = generateDeviceKey();
    const device = generateDeviceKey();

    const admission = admitDevice([], invite(admin, device), [admin.publicKey]);
    expect(admission.admitted).toBe(true);
    if (!admission.admitted) return;

    const signed = signEnvelope(envelopeFrom("device"), device.privateKey);
    // Both gates pass: cryptographically authentic and admitted.
    expect(verifySignedEvent(signed, device.publicKey)).toBe(true);
    expect(eventAccepted(admission.registry, device.publicKey, signed)).toBe(true);
  });

  it("rejects events from a device that was never admitted, even if the signature is valid (Req 5.4)", () => {
    const stranger = generateDeviceKey();
    const signed = signEnvelope(envelopeFrom("stranger"), stranger.privateKey);

    // The signature itself is authentic...
    expect(verifySignedEvent(signed, stranger.publicKey)).toBe(true);
    // ...but an empty registry authorises nobody.
    expect(canAuthenticate([], stranger.publicKey)).toBe(false);
    expect(eventAccepted([], stranger.publicKey, signed)).toBe(false);
  });

  it("stops honouring a device's authentic events once its key is revoked (Req 5.6)", () => {
    const admin = generateDeviceKey();
    const device = generateDeviceKey();

    const admission = admitDevice([], invite(admin, device), [admin.publicKey]);
    if (!admission.admitted) throw new Error("expected admission");

    const signed = signEnvelope(envelopeFrom("device"), device.privateKey);
    expect(eventAccepted(admission.registry, device.publicKey, signed)).toBe(true);

    const revoked = revokeDevice(admission.registry, device.publicKey);
    // Signature still verifies, but the revoked key is no longer authorised.
    expect(verifySignedEvent(signed, device.publicKey)).toBe(true);
    expect(eventAccepted(revoked, device.publicKey, signed)).toBe(false);
  });

  it("after rotation, honours the new key's events and retires the old key (Req 5.7)", () => {
    const admin = generateDeviceKey();
    const oldKey = generateDeviceKey();
    const newKey = generateDeviceKey();

    const admission = admitDevice([], invite(admin, oldKey), [admin.publicKey]);
    if (!admission.admitted) throw new Error("expected admission");

    const rotation = rotateDeviceKey(
      admission.registry,
      invite(admin, newKey),
      [admin.publicKey],
      oldKey.publicKey,
    );
    expect(rotation.admitted).toBe(true);
    if (!rotation.admitted) return;

    const oldSigned = signEnvelope(envelopeFrom("old"), oldKey.privateKey);
    const newSigned = signEnvelope(envelopeFrom("new"), newKey.privateKey);

    // New key: authentic and authorised.
    expect(eventAccepted(rotation.registry, newKey.publicKey, newSigned)).toBe(true);
    // Old key: signature still verifies, but the retired key is not authorised.
    expect(verifySignedEvent(oldSigned, oldKey.publicKey)).toBe(true);
    expect(eventAccepted(rotation.registry, oldKey.publicKey, oldSigned)).toBe(false);
  });

  it("leaves an already-admitted device authorised when a non-admin issues an invitation (Req 5.5)", () => {
    const admin = generateDeviceKey();
    const nonAdmin = generateDeviceKey();
    const device = generateDeviceKey();

    const admission = admitDevice([], invite(admin, device), [admin.publicKey]);
    if (!admission.admitted) throw new Error("expected admission");

    // A second device tries to join via an invitation signed by a non-admin.
    const intruder = generateDeviceKey();
    const rejected = admitDevice(
      admission.registry,
      invite(nonAdmin, intruder),
      [admin.publicKey],
    );
    expect(rejected).toMatchObject({
      admitted: false,
      code: "AUTH_ISSUER_NOT_ADMIN",
    });

    // Registry is unchanged: original device still authorised, intruder never added.
    expect(canAuthenticate(admission.registry, device.publicKey)).toBe(true);
    expect(canAuthenticate(admission.registry, intruder.publicKey)).toBe(false);
  });
});
