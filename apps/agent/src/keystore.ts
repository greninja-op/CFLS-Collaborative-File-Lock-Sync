/**
 * Device_Key storage integration (task 9.6; Req 5.1, 5.8, 5.9; design §8.2).
 *
 * The agent's Ed25519 Device_Key is generated locally (Req 5.1) and its private
 * half is held in the OS credential store with an encrypted-file fallback via
 * `@cfls/security`'s composite {@link createSecretStore}. If neither backend is
 * usable the store surfaces a {@link SecureStorageUnavailableError}; the agent
 * MUST fail closed and refuse to connect (Req 5.9) — this module never
 * substitutes an in-memory key.
 *
 * The stored secret is the full {@link DeviceKey} JSON (public + private halves)
 * so the agent can reconstruct its identity across restarts without re-deriving
 * the public key. Secret values are never logged.
 */

import {
  DEVICE_PRIVATE_KEY_SECRET,
  generateDeviceKey,
  SecureStorageUnavailableError,
  type DeviceKey,
  type SecretStore,
} from "@cfls/security";

/** True when `value` is a well-formed {@link DeviceKey} record. */
function isDeviceKey(value: unknown): value is DeviceKey {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as DeviceKey).publicKey === "string" &&
    typeof (value as DeviceKey).privateKey === "string"
  );
}

/**
 * Load the persisted Device_Key or generate-and-persist a fresh one on first run
 * (Req 5.1). Propagates {@link SecureStorageUnavailableError} unchanged so the
 * caller can fail closed (Req 5.9); a corrupt stored value is treated as
 * unusable and replaced with a freshly generated key.
 */
export async function loadOrCreateDeviceKey(
  store: SecretStore,
  secretName: string = DEVICE_PRIVATE_KEY_SECRET,
): Promise<DeviceKey> {
  // Probe availability first so an unusable store fails closed (Req 5.9).
  if (!(await store.isAvailable())) {
    throw new SecureStorageUnavailableError(
      "Device_Key secure storage is unavailable; refusing to start (Req 5.9).",
    );
  }

  const existing = await store.get(secretName);
  if (existing !== null) {
    try {
      const parsed: unknown = JSON.parse(existing);
      if (isDeviceKey(parsed)) {
        return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
      }
    } catch {
      // Fall through and regenerate on a corrupt value.
    }
  }

  const key = generateDeviceKey();
  await store.set(secretName, JSON.stringify(key));
  return key;
}
