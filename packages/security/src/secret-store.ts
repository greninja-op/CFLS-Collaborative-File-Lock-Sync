/**
 * Secret-store abstraction for the Device_Private_Key (Req 5.8, 5.9; design §8.2).
 *
 * The agent stores its Ed25519 private key in the OS credential store (Windows
 * Credential Manager) when available, and falls back to an encrypted file on disk
 * otherwise. When neither backend is usable, operations fail with a typed
 * {@link SecureStorageUnavailableError} carrying the protocol
 * `SECURE_STORAGE_UNAVAILABLE` error code so the agent can fail closed and refuse
 * to connect (Req 5.9).
 *
 * Security note: values handled here are secrets (private keys). Implementations
 * MUST NOT write secret values to logs or error messages.
 */

import type { ErrorCode } from "@cfls/protocol";

/** Default OS-credential-store "service" namespace for cfls secrets. */
export const DEFAULT_SECRET_SERVICE = "cfls-coordination-agent";

/** Canonical secret name under which the Device_Private_Key is stored. */
export const DEVICE_PRIVATE_KEY_SECRET = "device-private-key";

/**
 * A minimal async secret store keyed by a stable secret name. Backends persist
 * an opaque string value (e.g. a base64/PEM-encoded Device_Private_Key).
 */
export interface SecretStore {
  /**
   * Retrieve the secret, or `null` if no value is stored under `name`.
   * @throws SecureStorageUnavailableError when no backend is usable.
   */
  get(name: string): Promise<string | null>;

  /**
   * Store (or overwrite) the secret value under `name`.
   * @throws SecureStorageUnavailableError when no backend is usable.
   */
  set(name: string, value: string): Promise<void>;

  /**
   * Delete the secret under `name`. Resolves `true` if a value was removed,
   * `false` if there was nothing to remove.
   * @throws SecureStorageUnavailableError when no backend is usable.
   */
  delete(name: string): Promise<boolean>;

  /**
   * Probe whether this store can currently read/write secrets. Never throws;
   * returns `false` when the backend is unusable.
   */
  isAvailable(): Promise<boolean>;

  /** Human-readable identifier of the active backend (for diagnostics, not secrets). */
  readonly backend: SecretStoreBackend;
}

/** Which backend a store resolves to. */
export type SecretStoreBackend = "os-credential-store" | "encrypted-file" | "unavailable";

/**
 * Typed error surfaced when neither the OS credential store nor the encrypted-file
 * fallback can store or retrieve the Device_Private_Key (Req 5.9). Carries the
 * canonical protocol {@link ErrorCode} so callers can fail closed uniformly.
 */
export class SecureStorageUnavailableError extends Error {
  /** Always `'SECURE_STORAGE_UNAVAILABLE'`. */
  readonly code: Extract<ErrorCode, "SECURE_STORAGE_UNAVAILABLE"> =
    "SECURE_STORAGE_UNAVAILABLE";

  constructor(message = "No secure secret store is available", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SecureStorageUnavailableError";
    // Restore prototype chain for correct `instanceof` under transpilation.
    Object.setPrototypeOf(this, SecureStorageUnavailableError.prototype);
  }
}

/** Options shared by the credential-store factory and its backends. */
export interface SecretStoreOptions {
  /**
   * OS-credential-store "service" namespace. Defaults to
   * {@link DEFAULT_SECRET_SERVICE}.
   */
  serviceName?: string;
  /**
   * Force-disable the OS credential store (e.g. for tests or to exercise the
   * encrypted-file fallback). Defaults to `false`.
   */
  disableOsStore?: boolean;
  /**
   * Force-disable the encrypted-file fallback. Defaults to `false`.
   */
  disableFileStore?: boolean;
  /**
   * Directory for the encrypted-file fallback. Defaults to a per-user app-data
   * location (see {@link resolveDefaultFileStoreDir}).
   */
  fileStoreDir?: string;
  /**
   * Extra deployment-scoped entropy mixed into the file-fallback key derivation.
   * Optional; the fallback is still per-user/host-scoped without it.
   */
  appSecret?: string;
}
