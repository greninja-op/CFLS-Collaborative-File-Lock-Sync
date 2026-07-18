/**
 * @cfls/security — Ed25519 device identity, signing/verification, signed invitations,
 * revocation, key rotation, replay protection, and the OS credential store adapter.
 *
 * Identity/signing/invitation/replay logic lands in tasks 3.1–3.3 and 3.7.
 * This module exports the credential store (task 3.4).
 */

export const PACKAGE_NAME = "@cfls/security";

// ---- Signed invitations, revocation, key rotation (design §8.2, §8.5; Req 5.2, 5.5, 5.6, 5.7) ----
export {
  canonicalInvitationString,
  issueInvitation,
  verifyInvitationSignature,
  validateInvitation,
  admitDevice,
  rotateDeviceKey,
  revokeDevice,
  findMembershipEntry,
  isRevoked,
  isAdmitted,
  canAuthenticate,
} from "./invitations";
export type {
  InvitationClaims,
  SignedInvitation,
  MembershipRegistry,
  IssueInvitationParams,
  InvitationValidation,
  AdmissionResult,
} from "./invitations";

// ---- Ed25519 device identity (design §8.2; Req 5.1) ----
export {
  generateDeviceKey,
  publicKeyObject,
  privateKeyObject,
  deriveKeyId,
  deriveDeviceId,
} from "./keys";
export type {
  DeviceKey,
  DevicePublicKey,
  DevicePrivateKey,
} from "./keys";

// ---- Signing / verification of canonical envelopes (design §8.3; Req 7.1, 7.2) ----
export { signEnvelope, verifySignedEvent } from "./signing";

// ---- Credential store: Device_Private_Key secure storage (design §8.2; Req 5.8, 5.9) ----
export { createSecretStore } from "./credential-store";
export { createOsCredentialStore } from "./os-credential-store";
export {
  createEncryptedFileStore,
  resolveDefaultFileStoreDir,
} from "./encrypted-file-store";
export {
  SecureStorageUnavailableError,
  DEFAULT_SECRET_SERVICE,
  DEVICE_PRIVATE_KEY_SECRET,
} from "./secret-store";
export type {
  SecretStore,
  SecretStoreBackend,
  SecretStoreOptions,
} from "./secret-store";
