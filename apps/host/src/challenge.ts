/**
 * Ed25519 challenge-response primitives for the authentication handshake
 * (Req 5.3; design §4.1, §8.5 Spoofing mitigation).
 *
 * The handshake proves the connecting agent controls the `Device_Private_Key`
 * for the `Device_Public_Key` it presents: the host issues a random `nonce` and
 * the agent returns an Ed25519 signature over that nonce. We reuse the same key
 * objects as event signing (`@cfls/security`) so there is one identity notion,
 * but sign the raw challenge bytes directly rather than an event envelope.
 */

import { randomBytes, sign, verify } from "node:crypto";

import {
  privateKeyObject,
  publicKeyObject,
  type DevicePrivateKey,
  type DevicePublicKey,
} from "@cfls/security";

/** Generate a fresh random challenge nonce (base64), unpredictable per handshake. */
export function generateChallenge(): string {
  return randomBytes(32).toString("base64");
}

/** The exact bytes both sides sign/verify for a challenge nonce. */
function challengeMessage(nonce: string): Buffer {
  return Buffer.from(nonce, "utf8");
}

/**
 * Sign a challenge `nonce` with a `Device_Private_Key`, returning the base64
 * Ed25519 signature the agent sends in `auth.response` (Req 5.3).
 */
export function signChallenge(
  nonce: string,
  privateKey: DevicePrivateKey,
): string {
  return sign(
    null,
    challengeMessage(nonce),
    privateKeyObject(privateKey),
  ).toString("base64");
}

/**
 * Verify an `auth.response` signature over the challenge `nonce` against the
 * device's `Device_Public_Key` (Req 5.3). Returns `false` for any tampered,
 * malformed, or wrongly-keyed input rather than throwing.
 */
export function verifyChallenge(
  nonce: string,
  signature: string,
  publicKey: DevicePublicKey,
): boolean {
  try {
    return verify(
      null,
      challengeMessage(nonce),
      publicKeyObject(publicKey),
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}
