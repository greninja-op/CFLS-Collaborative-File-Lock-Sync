/**
 * Ed25519 `Device_Key` generation and (de)serialization (Req 5.1; design §8.2).
 *
 * A device's identity is a locally generated Ed25519 key pair. We keep the
 * serializable form as the **raw 32-byte** public/private key encoded as standard
 * base64: it is compact, language-agnostic, and exactly the `Device_Public_Key`
 * value registered with the host. Node's `crypto` `KeyObject`s are reconstructed
 * on demand for signing/verification by wrapping the raw bytes in the fixed
 * Ed25519 DER prefixes.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";

/**
 * A `Device_Public_Key`: the raw 32-byte Ed25519 public key, standard-base64
 * encoded. This is the stable, serializable identity value registered with the
 * CoordinationHost and used to verify a device's Signed_Events.
 */
export type DevicePublicKey = string;

/**
 * A `Device_Private_Key`: the raw 32-byte Ed25519 seed, standard-base64 encoded.
 * Held only by the owning device (stored in the OS credential store — task 3.4).
 */
export type DevicePrivateKey = string;

/** A locally generated Ed25519 key pair identifying a single device (Req 5.1). */
export interface DeviceKey {
  /** Raw 32-byte Ed25519 public key, base64. */
  publicKey: DevicePublicKey;
  /** Raw 32-byte Ed25519 private seed, base64. */
  privateKey: DevicePrivateKey;
}

/**
 * Fixed ASN.1/DER prefix for an Ed25519 SubjectPublicKeyInfo (SPKI). Prepended to
 * the raw 32-byte public key to reconstruct a DER blob Node can import.
 */
const SPKI_DER_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Fixed ASN.1/DER prefix for an Ed25519 PKCS#8 private key. Prepended to the raw
 * 32-byte seed to reconstruct a DER blob Node can import.
 */
const PKCS8_DER_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);

/** Raw Ed25519 key length in bytes (both public key and private seed). */
const RAW_KEY_LENGTH = 32;

/**
 * Generate a fresh Ed25519 {@link DeviceKey} (Req 5.1). Keys are produced with
 * Node's built-in `crypto` and returned in the stable raw-base64 form.
 */
export function generateDeviceKey(): DeviceKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubJwk = publicKey.export({ format: "jwk" }) as { x?: string };
  const privJwk = privateKey.export({ format: "jwk" }) as { d?: string };

  if (typeof pubJwk.x !== "string" || typeof privJwk.d !== "string") {
    throw new Error("Failed to extract raw Ed25519 key material.");
  }

  return {
    publicKey: Buffer.from(pubJwk.x, "base64url").toString("base64"),
    privateKey: Buffer.from(privJwk.d, "base64url").toString("base64"),
  };
}

/**
 * Reconstruct a public {@link KeyObject} from a raw-base64 {@link DevicePublicKey}.
 * Throws if the encoding or length is invalid.
 */
export function publicKeyObject(publicKey: DevicePublicKey): KeyObject {
  const raw = decodeRawKey(publicKey);
  return createPublicKey({
    key: Buffer.concat([SPKI_DER_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

/**
 * Reconstruct a private {@link KeyObject} from a raw-base64 {@link DevicePrivateKey}.
 * Throws if the encoding or length is invalid.
 */
export function privateKeyObject(privateKey: DevicePrivateKey): KeyObject {
  const raw = decodeRawKey(privateKey);
  return createPrivateKey({
    key: Buffer.concat([PKCS8_DER_PREFIX, raw]),
    format: "der",
    type: "pkcs8",
  });
}

/**
 * Derive a stable, collision-resistant key identifier from a
 * {@link DevicePublicKey} — the base64url SHA-256 of the raw public key. Because
 * it is a deterministic function of the public key alone, it is usable directly
 * as a device identifier (`deviceId`) across processes and restarts.
 */
export function deriveKeyId(publicKey: DevicePublicKey): string {
  const raw = decodeRawKey(publicKey);
  return createHash("sha256").update(raw).digest("base64url");
}

/**
 * Convenience alias for {@link deriveKeyId}: the canonical `deviceId` derived from
 * a device's public key.
 */
export function deriveDeviceId(publicKey: DevicePublicKey): string {
  return deriveKeyId(publicKey);
}

/** Decode a raw-base64 key and validate its length. */
function decodeRawKey(encoded: DevicePublicKey | DevicePrivateKey): Buffer {
  const raw = Buffer.from(encoded, "base64");
  if (raw.length !== RAW_KEY_LENGTH) {
    throw new Error(
      `Invalid Ed25519 key length: expected ${RAW_KEY_LENGTH} bytes, got ${raw.length}.`,
    );
  }
  return raw;
}
