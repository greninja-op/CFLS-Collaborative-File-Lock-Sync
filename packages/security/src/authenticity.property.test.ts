/**
 * Property 5 — Only authentically signed, admitted events mutate state.
 *
 * **Validates: Requirements 7.2, 7.3, 5.4, 5.6**
 *
 * The host's ingest gate must apply an event to authoritative state if and only if
 * (a) the event's signature authentically verifies against the sending device's
 * registered `Device_Public_Key` (Req 7.2, 7.3), and (b) that device is admitted
 * and not revoked in the `Membership_Registry` (Req 5.4, 5.6). An invalid signature
 * (tampered payload, wrong key, or garbage bytes) or a device that is absent or
 * revoked must leave state unchanged.
 *
 * This test exercises that biconditional over randomized combinations of
 * signature-authenticity and membership-status using the real Ed25519 signing
 * (`signEnvelope`/`verifySignedEvent`) and membership predicates (`admitDevice`/
 * `revokeDevice`/`canAuthenticate`).
 */

import { buildEnvelope, type EventEnvelope, type SignedEvent } from "@cfls/protocol";
import { assertProperty, fc, propertyTag } from "@cfls/test-utils";
import { describe, expect, it } from "vitest";

import {
  admitDevice,
  canAuthenticate,
  issueInvitation,
  revokeDevice,
  type MembershipRegistry,
} from "./invitations";
import { deriveDeviceId, generateDeviceKey, type DeviceKey } from "./keys";
import { signEnvelope, verifySignedEvent } from "./signing";

const SESSION = {
  repoId: "repo-1",
  teamId: "team-1",
  branch: "main",
  baseRevision: null,
} as const;

/** How a signed event's authenticity is (or isn't) compromised. */
type Corruption = "authentic" | "tampered" | "wrong-key" | "garbage-signature";

/**
 * The host ingest gate under test: an event mutates authoritative state iff the
 * sending device is admitted & non-revoked AND its signature authentically
 * verifies against its registered public key. Returns the (possibly unchanged)
 * state alongside whether a mutation occurred.
 */
function ingest(
  state: number,
  registry: MembershipRegistry,
  signed: SignedEvent,
  signerPublicKey: string,
): { state: number; mutated: boolean } {
  // Authenticity is checked against the registered device key before any change.
  const authentic = verifySignedEvent(signed, signerPublicKey);
  const admitted = canAuthenticate(registry, signerPublicKey);
  if (authentic && admitted) {
    return { state: state + 1, mutated: true };
  }
  return { state, mutated: false };
}

function envelopeFor(signer: DeviceKey, eventId: string, path: string): EventEnvelope {
  return buildEnvelope({
    type: "presence.report",
    eventId,
    session: SESSION,
    deviceId: deriveDeviceId(signer.publicKey),
    replay: { counter: 1, nonce: "bm9uY2U=" },
    payload: { path, state: "editing" },
    sentAt: "2024-01-01T10:00:00Z",
  });
}

describe(propertyTag(5, "Only authentically signed, admitted events mutate state"), () => {
  it("mutates state iff the event is authentically signed by an admitted, non-revoked device", () => {
    assertProperty(
      fc.property(
        fc.constantFrom<Corruption>(
          "authentic",
          "tampered",
          "wrong-key",
          "garbage-signature",
        ),
        fc.boolean(), // device admitted into the registry?
        fc.boolean(), // device subsequently revoked?
        fc.uuid(),
        fc.string({ minLength: 1, maxLength: 64 }),
        (corruption, admit, revoke, eventId, path) => {
          const admin = generateDeviceKey();
          const signer = generateDeviceKey();
          const other = generateDeviceKey();

          // Build the membership registry view the host would hold.
          let registry: MembershipRegistry = [];
          if (admit) {
            const invitation = issueInvitation(
              {
                session: SESSION,
                devicePublicKey: signer.publicKey,
                memberId: "member-1",
                issuerPublicKey: admin.publicKey,
              },
              admin.privateKey,
            );
            const result = admitDevice(registry, invitation, [admin.publicKey]);
            if (!result.admitted) throw new Error("expected admission to succeed");
            registry = result.registry;
          }
          if (revoke) {
            registry = revokeDevice(registry, signer.publicKey);
          }

          // Produce the signed event with the requested authenticity condition.
          const envelope = envelopeFor(signer, eventId, path);
          let signed: SignedEvent;
          switch (corruption) {
            case "authentic":
              signed = signEnvelope(envelope, signer.privateKey);
              break;
            case "tampered": {
              const good = signEnvelope(envelope, signer.privateKey);
              signed = {
                ...good,
                envelope: {
                  ...good.envelope,
                  payload: { path: `${path}.tampered`, state: "editing" },
                },
              };
              break;
            }
            case "wrong-key":
              // Signed by a different device than the claimed/registered key.
              signed = signEnvelope(envelope, other.privateKey);
              break;
            case "garbage-signature": {
              const good = signEnvelope(envelope, signer.privateKey);
              signed = { ...good, signature: "!!!not-a-valid-signature!!!" };
              break;
            }
          }

          const authentic = corruption === "authentic";
          const admittedActive = admit && !revoke;
          const expectedMutation = authentic && admittedActive;

          const before = 42;
          const { state, mutated } = ingest(
            before,
            registry,
            signed,
            signer.publicKey,
          );

          // The core biconditional: acceptance holds exactly when authentic + admitted.
          expect(mutated).toBe(expectedMutation);

          // A mutation implies both authenticity and admission (Req 7.2/7.3, 5.4/5.6).
          if (mutated) {
            expect(verifySignedEvent(signed, signer.publicKey)).toBe(true);
            expect(canAuthenticate(registry, signer.publicKey)).toBe(true);
            expect(state).toBe(before + 1);
          } else {
            // Rejected events leave state unchanged.
            expect(state).toBe(before);
          }
        },
      ),
    );
  });
});
