/**
 * Signed invitations, revocation, and key-rotation checks (Req 5.2, 5.5, 5.6, 5.7;
 * design §8.2, §8.5).
 *
 * A `Signed_Invitation` is an admission credential a `Team_Admin` device issues to
 * grant another device (identified by its `Device_Public_Key`) access to a
 * `Repository_Session`. Admission requires an invitation whose signature both
 *   (a) authentically verifies against the issuer's public key, and
 *   (b) chains to a public key the session recognizes as an authorized admin.
 *
 * The functions here are **pure predicates over a `Membership_Registry` view**
 * (`readonly MembershipRegistryEntry[]`). They never mutate their input: admission,
 * revocation, and rotation each return a fresh registry array so the caller (the
 * host) decides when to persist. Signing/verification reuses the same Ed25519
 * primitives as event signing (`./keys`), and the exact signed bytes are the
 * canonical JSON of the invitation claims (`@cfls/protocol` `canonicalize`), the
 * single cross-process source of truth.
 *
 * Security note: invitations carry only public keys, a member id, session
 * coordinates, and timestamps — never secrets or source content.
 */

import { sign, verify } from "node:crypto";
import {
  canonicalize,
  type ErrorCode,
  type MembershipRegistryEntry,
  type SessionId,
} from "@cfls/protocol";

import {
  privateKeyObject,
  publicKeyObject,
  type DevicePrivateKey,
  type DevicePublicKey,
} from "./keys";

/**
 * The signed body of a {@link SignedInvitation}. These are exactly the bytes the
 * issuer's Ed25519 signature covers (via {@link canonicalInvitationString}).
 */
export interface InvitationClaims {
  /** The Repository_Session the invitation grants access to. */
  session: SessionId;
  /** The invited device's `Device_Public_Key` (raw-base64, see `./keys`). */
  devicePublicKey: DevicePublicKey;
  /** The Team_Member identity the invited device will be associated with. */
  memberId: string;
  /** The issuing Team_Admin device's `Device_Public_Key`. */
  issuerPublicKey: DevicePublicKey;
  /** ISO-8601 issuance timestamp. */
  issuedAt: string;
  /** ISO-8601 expiry, or `null` for an invitation that does not expire. */
  expiresAt: string | null;
}

/**
 * A cryptographically signed admission credential (Req 5.2). The `signature` is a
 * base64 Ed25519 signature by the issuer's `Device_Private_Key` over
 * {@link canonicalInvitationString}`(claims)`.
 */
export interface SignedInvitation {
  claims: InvitationClaims;
  signature: string;
}

/** A read-only Membership_Registry view (Req 5.2). */
export type MembershipRegistry = readonly MembershipRegistryEntry[];

/** Inputs for {@link issueInvitation}; timestamps default to sensible values. */
export interface IssueInvitationParams {
  session: SessionId;
  /** The invited device's public key. */
  devicePublicKey: DevicePublicKey;
  memberId: string;
  /** The issuing admin device's public key (must match `issuerPrivateKey`). */
  issuerPublicKey: DevicePublicKey;
  /** ISO-8601 issuance time; defaults to now. */
  issuedAt?: string;
  /** ISO-8601 expiry, or `null`/omitted for no expiry. */
  expiresAt?: string | null;
}

/** Outcome of validating a {@link SignedInvitation}. */
export type InvitationValidation =
  | { valid: true }
  | { valid: false; code: ErrorCode; reason: string };

/** Outcome of an admission or rotation attempt over a Membership_Registry view. */
export type AdmissionResult =
  | {
      admitted: true;
      /** A fresh registry array reflecting the admission/rotation. */
      registry: MembershipRegistryEntry[];
      /** The entry that was added (or replaced). */
      entry: MembershipRegistryEntry;
    }
  | { admitted: false; code: ErrorCode; reason: string };

/**
 * Produce the canonical string an invitation signature covers. Signer and verifier
 * MUST both feed this string's UTF-8 bytes to Ed25519.
 */
export function canonicalInvitationString(claims: InvitationClaims): string {
  return canonicalize({
    session: claims.session,
    devicePublicKey: claims.devicePublicKey,
    memberId: claims.memberId,
    issuerPublicKey: claims.issuerPublicKey,
    issuedAt: claims.issuedAt,
    expiresAt: claims.expiresAt,
  });
}

/**
 * Issue a {@link SignedInvitation} from an admin device (Req 5.2). The claims are
 * canonicalized and signed with the admin's `Device_Private_Key`. The caller is
 * responsible for ensuring `issuerPublicKey` corresponds to `issuerPrivateKey`;
 * a mismatch simply yields an invitation whose signature will not verify.
 */
export function issueInvitation(
  params: IssueInvitationParams,
  issuerPrivateKey: DevicePrivateKey,
): SignedInvitation {
  const claims: InvitationClaims = {
    session: params.session,
    devicePublicKey: params.devicePublicKey,
    memberId: params.memberId,
    issuerPublicKey: params.issuerPublicKey,
    issuedAt: params.issuedAt ?? new Date().toISOString(),
    expiresAt: params.expiresAt ?? null,
  };
  const message = Buffer.from(canonicalInvitationString(claims), "utf8");
  const signature = sign(null, message, privateKeyObject(issuerPrivateKey));
  return { claims, signature: signature.toString("base64") };
}

/**
 * Verify that an invitation's signature was produced by the issuer named in its
 * own claims. Returns `false` for any tampered, malformed, or wrongly-keyed
 * invitation rather than throwing, so it can be used as a pure predicate.
 */
export function verifyInvitationSignature(invitation: SignedInvitation): boolean {
  try {
    const message = Buffer.from(
      canonicalInvitationString(invitation.claims),
      "utf8",
    );
    const signature = Buffer.from(invitation.signature, "base64");
    return verify(
      null,
      message,
      publicKeyObject(invitation.claims.issuerPublicKey),
      signature,
    );
  } catch {
    return false;
  }
}

/**
 * Validate a {@link SignedInvitation} before admission (Req 5.4, 5.5; design §8.2):
 *
 * 1. The signature must authentically verify against the claimed issuer key,
 *    otherwise `AUTH_INVALID_DEVICE` (malformed/forged invitation, Req 5.4).
 * 2. The invitation must not be expired, otherwise `AUTH_INVALID_DEVICE` (Req 5.4).
 * 3. The issuer key must be one of the session's authorized admin keys, otherwise
 *    `AUTH_ISSUER_NOT_ADMIN` (Req 5.5).
 *
 * The signature is always checked first: an unauthentic invitation is rejected as
 * a bad device credential, and only an authentic-but-non-admin issuer yields the
 * distinct issuer-not-admin code.
 */
export function validateInvitation(
  invitation: SignedInvitation,
  authorizedAdminKeys: Iterable<DevicePublicKey>,
  options: { now?: Date } = {},
): InvitationValidation {
  if (!verifyInvitationSignature(invitation)) {
    return {
      valid: false,
      code: "AUTH_INVALID_DEVICE",
      reason: "Invitation signature is invalid or malformed.",
    };
  }

  const now = options.now ?? new Date();
  const { expiresAt } = invitation.claims;
  if (expiresAt !== null) {
    const expiry = Date.parse(expiresAt);
    if (Number.isNaN(expiry)) {
      return {
        valid: false,
        code: "AUTH_INVALID_DEVICE",
        reason: "Invitation has a malformed expiry timestamp.",
      };
    }
    if (now.getTime() > expiry) {
      return {
        valid: false,
        code: "AUTH_INVALID_DEVICE",
        reason: "Invitation has expired.",
      };
    }
  }

  const adminSet = new Set(authorizedAdminKeys);
  if (!adminSet.has(invitation.claims.issuerPublicKey)) {
    return {
      valid: false,
      code: "AUTH_ISSUER_NOT_ADMIN",
      reason: "Invitation issuer is not an authorized admin for the session.",
    };
  }

  return { valid: true };
}

/**
 * Admit a device into a Membership_Registry via a valid invitation (Req 5.2).
 * Validates the invitation (see {@link validateInvitation}); on success returns a
 * fresh registry with an entry for the invited device (replacing any prior entry
 * for the same key), marked `invitationValid` and not revoked. On failure the
 * registry is left unchanged (Req 5.5) and the authorization error is returned.
 */
export function admitDevice(
  registry: MembershipRegistry,
  invitation: SignedInvitation,
  authorizedAdminKeys: Iterable<DevicePublicKey>,
  options: { now?: Date } = {},
): AdmissionResult {
  const validation = validateInvitation(
    invitation,
    authorizedAdminKeys,
    options,
  );
  if (!validation.valid) {
    return {
      admitted: false,
      code: validation.code,
      reason: validation.reason,
    };
  }

  const entry: MembershipRegistryEntry = {
    devicePublicKey: invitation.claims.devicePublicKey,
    memberId: invitation.claims.memberId,
    invitationValid: true,
    revoked: false,
  };

  return {
    admitted: true,
    registry: upsertEntry(registry, entry),
    entry,
  };
}

/**
 * Admit a rotated `Device_Public_Key` and retire the previous one (Req 5.7). The
 * new key is admitted through a valid invitation (same checks as
 * {@link admitDevice}); the new entry records `rotatedFrom` = the previous key, and
 * the previous key's entry is retired (marked revoked) so the host authenticates
 * subsequent events only against the new key. If `previousDevicePublicKey` is not
 * present in the registry the admission still succeeds (nothing to retire).
 */
export function rotateDeviceKey(
  registry: MembershipRegistry,
  invitation: SignedInvitation,
  authorizedAdminKeys: Iterable<DevicePublicKey>,
  previousDevicePublicKey: DevicePublicKey,
  options: { now?: Date } = {},
): AdmissionResult {
  const validation = validateInvitation(
    invitation,
    authorizedAdminKeys,
    options,
  );
  if (!validation.valid) {
    return {
      admitted: false,
      code: validation.code,
      reason: validation.reason,
    };
  }

  const entry: MembershipRegistryEntry = {
    devicePublicKey: invitation.claims.devicePublicKey,
    memberId: invitation.claims.memberId,
    invitationValid: true,
    revoked: false,
    rotatedFrom: previousDevicePublicKey,
  };

  const retired = registry.map((existing) =>
    existing.devicePublicKey === previousDevicePublicKey
      ? { ...existing, revoked: true }
      : existing,
  );

  return {
    admitted: true,
    registry: upsertEntry(retired, entry),
    entry,
  };
}

/**
 * Revoke a device's `Device_Public_Key` (Req 5.6). Returns a fresh registry with
 * the matching entry marked revoked; a key that is absent leaves the registry
 * effectively unchanged (a copy is still returned). After revocation the device
 * fails {@link canAuthenticate}, so the host rejects its connections and events.
 */
export function revokeDevice(
  registry: MembershipRegistry,
  devicePublicKey: DevicePublicKey,
): MembershipRegistryEntry[] {
  return registry.map((entry) =>
    entry.devicePublicKey === devicePublicKey
      ? { ...entry, revoked: true }
      : entry,
  );
}

/** Find the registry entry for a device key, if any. */
export function findMembershipEntry(
  registry: MembershipRegistry,
  devicePublicKey: DevicePublicKey,
): MembershipRegistryEntry | undefined {
  return registry.find((entry) => entry.devicePublicKey === devicePublicKey);
}

/** Is this device key present and marked revoked in the registry (Req 5.6)? */
export function isRevoked(
  registry: MembershipRegistry,
  devicePublicKey: DevicePublicKey,
): boolean {
  return findMembershipEntry(registry, devicePublicKey)?.revoked === true;
}

/**
 * Is this device key admitted for the session (Req 5.3): present, holding a valid
 * invitation, and not revoked.
 */
export function isAdmitted(
  registry: MembershipRegistry,
  devicePublicKey: DevicePublicKey,
): boolean {
  const entry = findMembershipEntry(registry, devicePublicKey);
  return entry !== undefined && entry.invitationValid && !entry.revoked;
}

/**
 * May the host authenticate connections/events from this device key (Req 5.3, 5.4,
 * 5.6)? True iff the key is admitted and not revoked — the predicate the host
 * applies before accepting a connection or a Signed_Event.
 */
export function canAuthenticate(
  registry: MembershipRegistry,
  devicePublicKey: DevicePublicKey,
): boolean {
  return isAdmitted(registry, devicePublicKey);
}

/** Return a fresh registry with `entry` inserted, replacing any entry for the same key. */
function upsertEntry(
  registry: MembershipRegistry,
  entry: MembershipRegistryEntry,
): MembershipRegistryEntry[] {
  const next = registry.filter(
    (existing) => existing.devicePublicKey !== entry.devicePublicKey,
  );
  next.push(entry);
  return next;
}
