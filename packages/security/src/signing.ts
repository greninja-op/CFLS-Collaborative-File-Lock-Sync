/**
 * Signing and verification of coordination events (Req 7.1–7.3; design §8.3).
 *
 * The exact bytes a signature covers are owned by `@cfls/protocol`:
 * {@link canonicalEnvelopeString} is the single source of truth for both signer
 * and verifier. We sign/verify its UTF-8 bytes with Ed25519 via Node's built-in
 * `crypto`, and detached signatures are carried base64-encoded on the
 * {@link SignedEvent}.
 */

import { sign, verify } from "node:crypto";
import {
  canonicalEnvelopeString,
  toSignedEvent,
  type EventEnvelope,
  type SignedEvent,
} from "@cfls/protocol";

import {
  privateKeyObject,
  publicKeyObject,
  type DevicePrivateKey,
  type DevicePublicKey,
} from "./keys";

/**
 * Sign an {@link EventEnvelope} with a device's private key (Req 7.1). The
 * canonical envelope string is Ed25519-signed and the base64 signature attached,
 * yielding a {@link SignedEvent} ready for transmission.
 */
export function signEnvelope(
  envelope: EventEnvelope,
  privateKey: DevicePrivateKey,
): SignedEvent {
  const message = Buffer.from(canonicalEnvelopeString(envelope), "utf8");
  const signature = sign(null, message, privateKeyObject(privateKey));
  return toSignedEvent(envelope, signature.toString("base64"));
}

/**
 * Verify a {@link SignedEvent} against a {@link DevicePublicKey} (Req 7.2, 7.3).
 * Recomputes the canonical envelope string and checks the detached Ed25519
 * signature. Returns `false` for any tampered, malformed, or wrongly-keyed input
 * rather than throwing, so callers can treat verification as a pure predicate.
 */
export function verifySignedEvent(
  signedEvent: SignedEvent,
  publicKey: DevicePublicKey,
): boolean {
  try {
    const message = Buffer.from(
      canonicalEnvelopeString(signedEvent.envelope),
      "utf8",
    );
    const signature = Buffer.from(signedEvent.signature, "base64");
    return verify(null, message, publicKeyObject(publicKey), signature);
  } catch {
    return false;
  }
}
