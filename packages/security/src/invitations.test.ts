/**
 * Unit tests for signed invitations, revocation, and key rotation (Req 5.2, 5.5,
 * 5.6, 5.7; design §8.2). Covers: authentic issuance/verification, tampered and
 * expired invitations, non-admin issuer rejection with an unchanged registry,
 * admission, revocation, and rotation retiring the previous key.
 */

import { describe, expect, it } from "vitest";
import type { MembershipRegistryEntry, SessionId } from "@cfls/protocol";

import { generateDeviceKey } from "./keys";
import {
  admitDevice,
  canAuthenticate,
  findMembershipEntry,
  isAdmitted,
  isRevoked,
  issueInvitation,
  revokeDevice,
  rotateDeviceKey,
  validateInvitation,
  verifyInvitationSignature,
  type SignedInvitation,
} from "./invitations";

const SESSION: SessionId = {
  repoId: "repo-1",
  teamId: "team-1",
  branch: "main",
  baseRevision: null,
};

/** An admin device plus a fresh device to be invited. */
function actors() {
  const admin = generateDeviceKey();
  const device = generateDeviceKey();
  return { admin, device };
}

/** Issue a valid invitation for `device` signed by `admin`. */
function invite(
  admin: ReturnType<typeof generateDeviceKey>,
  device: ReturnType<typeof generateDeviceKey>,
  overrides: { memberId?: string; issuedAt?: string; expiresAt?: string | null } = {},
): SignedInvitation {
  return issueInvitation(
    {
      session: SESSION,
      devicePublicKey: device.publicKey,
      memberId: overrides.memberId ?? "member-1",
      issuerPublicKey: admin.publicKey,
      issuedAt: overrides.issuedAt,
      expiresAt: overrides.expiresAt,
    },
    admin.privateKey,
  );
}

describe("issueInvitation / verifyInvitationSignature", () => {
  it("issues an invitation whose signature verifies against the issuer key", () => {
    const { admin, device } = actors();
    const invitation = invite(admin, device);

    expect(verifyInvitationSignature(invitation)).toBe(true);
    expect(invitation.claims.issuerPublicKey).toBe(admin.publicKey);
    expect(invitation.claims.devicePublicKey).toBe(device.publicKey);
  });

  it("rejects a tampered invitation (claims mutated after signing)", () => {
    const { admin, device } = actors();
    const invitation = invite(admin, device);
    const tampered: SignedInvitation = {
      ...invitation,
      claims: { ...invitation.claims, memberId: "attacker" },
    };

    expect(verifyInvitationSignature(tampered)).toBe(false);
  });
});

describe("validateInvitation", () => {
  it("accepts an authentic invitation from an authorized admin", () => {
    const { admin, device } = actors();
    const invitation = invite(admin, device);

    expect(validateInvitation(invitation, [admin.publicKey])).toEqual({
      valid: true,
    });
  });

  it("rejects an invitation whose signature is invalid (AUTH_INVALID_DEVICE)", () => {
    const { admin, device } = actors();
    const invitation = invite(admin, device);
    const forged: SignedInvitation = { ...invitation, signature: "AAAA" };

    const result = validateInvitation(forged, [admin.publicKey]);
    expect(result).toMatchObject({ valid: false, code: "AUTH_INVALID_DEVICE" });
  });

  it("rejects an invitation from a non-admin issuer (AUTH_ISSUER_NOT_ADMIN)", () => {
    const { admin, device } = actors();
    const nonAdmin = generateDeviceKey();
    const invitation = invite(nonAdmin, device);

    const result = validateInvitation(invitation, [admin.publicKey]);
    expect(result).toMatchObject({
      valid: false,
      code: "AUTH_ISSUER_NOT_ADMIN",
    });
  });

  it("rejects an expired invitation (AUTH_INVALID_DEVICE)", () => {
    const { admin, device } = actors();
    const invitation = invite(admin, device, {
      issuedAt: "2024-01-01T00:00:00.000Z",
      expiresAt: "2024-01-02T00:00:00.000Z",
    });

    const result = validateInvitation(invitation, [admin.publicKey], {
      now: new Date("2024-02-01T00:00:00.000Z"),
    });
    expect(result).toMatchObject({ valid: false, code: "AUTH_INVALID_DEVICE" });
  });

  it("accepts a not-yet-expired invitation at a time before its expiry", () => {
    const { admin, device } = actors();
    const invitation = invite(admin, device, {
      issuedAt: "2024-01-01T00:00:00.000Z",
      expiresAt: "2024-01-10T00:00:00.000Z",
    });

    expect(
      validateInvitation(invitation, [admin.publicKey], {
        now: new Date("2024-01-05T00:00:00.000Z"),
      }),
    ).toEqual({ valid: true });
  });
});

describe("admitDevice", () => {
  it("adds an admitted, non-revoked entry for a valid invitation", () => {
    const { admin, device } = actors();
    const invitation = invite(admin, device);

    const result = admitDevice([], invitation, [admin.publicKey]);
    expect(result.admitted).toBe(true);
    if (!result.admitted) return;

    expect(result.entry).toEqual<MembershipRegistryEntry>({
      devicePublicKey: device.publicKey,
      memberId: "member-1",
      invitationValid: true,
      revoked: false,
    });
    expect(isAdmitted(result.registry, device.publicKey)).toBe(true);
    expect(canAuthenticate(result.registry, device.publicKey)).toBe(true);
  });

  it("leaves the registry unchanged when the issuer is not an admin", () => {
    const { admin, device } = actors();
    const nonAdmin = generateDeviceKey();
    const invitation = invite(nonAdmin, device);
    const registry: MembershipRegistryEntry[] = [];

    const result = admitDevice(registry, invitation, [admin.publicKey]);
    expect(result).toMatchObject({
      admitted: false,
      code: "AUTH_ISSUER_NOT_ADMIN",
    });
    expect(registry).toHaveLength(0);
  });

  it("replaces a prior entry for the same device key rather than duplicating", () => {
    const { admin, device } = actors();
    const first = admitDevice([], invite(admin, device), [admin.publicKey]);
    expect(first.admitted).toBe(true);
    if (!first.admitted) return;

    const second = admitDevice(
      first.registry,
      invite(admin, device, { memberId: "member-2" }),
      [admin.publicKey],
    );
    expect(second.admitted).toBe(true);
    if (!second.admitted) return;

    const entries = second.registry.filter(
      (e) => e.devicePublicKey === device.publicKey,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.memberId).toBe("member-2");
  });
});

describe("revokeDevice", () => {
  it("marks the device revoked so it can no longer authenticate", () => {
    const { admin, device } = actors();
    const admitted = admitDevice([], invite(admin, device), [admin.publicKey]);
    expect(admitted.admitted).toBe(true);
    if (!admitted.admitted) return;

    const revoked = revokeDevice(admitted.registry, device.publicKey);
    expect(isRevoked(revoked, device.publicKey)).toBe(true);
    expect(canAuthenticate(revoked, device.publicKey)).toBe(false);
  });

  it("does not mutate the input registry", () => {
    const { admin, device } = actors();
    const admitted = admitDevice([], invite(admin, device), [admin.publicKey]);
    if (!admitted.admitted) throw new Error("expected admission");

    revokeDevice(admitted.registry, device.publicKey);
    expect(isRevoked(admitted.registry, device.publicKey)).toBe(false);
  });
});

describe("rotateDeviceKey", () => {
  it("admits the new key and retires the previous key", () => {
    const { admin, device } = actors();
    const admitted = admitDevice([], invite(admin, device), [admin.publicKey]);
    if (!admitted.admitted) throw new Error("expected admission");

    const rotatedKey = generateDeviceKey();
    const rotationInvite = invite(admin, rotatedKey, { memberId: "member-1" });

    const result = rotateDeviceKey(
      admitted.registry,
      rotationInvite,
      [admin.publicKey],
      device.publicKey,
    );
    expect(result.admitted).toBe(true);
    if (!result.admitted) return;

    // New key authenticates and records where it rotated from.
    expect(canAuthenticate(result.registry, rotatedKey.publicKey)).toBe(true);
    expect(
      findMembershipEntry(result.registry, rotatedKey.publicKey)?.rotatedFrom,
    ).toBe(device.publicKey);

    // Old key is retired.
    expect(canAuthenticate(result.registry, device.publicKey)).toBe(false);
    expect(isRevoked(result.registry, device.publicKey)).toBe(true);
  });

  it("rejects rotation through an invalid (non-admin) invitation", () => {
    const { admin, device } = actors();
    const admitted = admitDevice([], invite(admin, device), [admin.publicKey]);
    if (!admitted.admitted) throw new Error("expected admission");

    const nonAdmin = generateDeviceKey();
    const rotatedKey = generateDeviceKey();
    const result = rotateDeviceKey(
      admitted.registry,
      invite(nonAdmin, rotatedKey),
      [admin.publicKey],
      device.publicKey,
    );

    expect(result).toMatchObject({
      admitted: false,
      code: "AUTH_ISSUER_NOT_ADMIN",
    });
    // Old key remains valid because rotation was rejected.
    expect(canAuthenticate(admitted.registry, device.publicKey)).toBe(true);
  });
});
