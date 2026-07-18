/**
 * Composite credential store (design §8.2; Req 5.8, 5.9).
 *
 * Resolves the first usable backend — OS credential store first, then the
 * encrypted-file fallback — and routes all secret operations to it. When neither
 * backend is usable, every operation throws a {@link SecureStorageUnavailableError}
 * (protocol `SECURE_STORAGE_UNAVAILABLE`) so the agent can fail closed and refuse
 * to connect (Req 5.9).
 *
 * The chosen backend is memoized after the first successful resolution to keep a
 * single consistent storage location for the Device_Private_Key across operations.
 */

import { createEncryptedFileStore } from "./encrypted-file-store";
import { createOsCredentialStore } from "./os-credential-store";
import type { SecretStore, SecretStoreBackend, SecretStoreOptions } from "./secret-store";
import { SecureStorageUnavailableError } from "./secret-store";

/**
 * Create the composite Device_Private_Key secret store.
 *
 * Backend selection order: OS credential store → encrypted-file fallback. The
 * `disableOsStore` / `disableFileStore` options can constrain the candidates
 * (e.g. to force the fallback in a test/CI environment).
 */
export function createSecretStore(options: SecretStoreOptions = {}): SecretStore {
  const candidates: SecretStore[] = [];
  if (options.disableOsStore !== true) {
    candidates.push(createOsCredentialStore(options.serviceName));
  }
  if (options.disableFileStore !== true) {
    candidates.push(
      createEncryptedFileStore({
        ...(options.fileStoreDir !== undefined ? { fileStoreDir: options.fileStoreDir } : {}),
        ...(options.appSecret !== undefined ? { appSecret: options.appSecret } : {}),
      }),
    );
  }

  // Per-instance state.
  let resolved: Promise<SecretStore> | undefined;
  let activeBackend: SecretStoreBackend = "unavailable";

  async function resolveBackend(): Promise<SecretStore> {
    if (resolved === undefined) {
      const attempt = (async (): Promise<SecretStore> => {
        for (const candidate of candidates) {
          if (await candidate.isAvailable()) {
            return candidate;
          }
        }
        throw new SecureStorageUnavailableError(
          "Neither the OS credential store nor the encrypted-file fallback is available",
        );
      })();
      resolved = attempt;
      // If resolution fails, clear the cache so a later call can re-probe
      // (e.g. after the OS store becomes available again).
      attempt.catch(() => {
        if (resolved === attempt) resolved = undefined;
      });
    }
    const store = await resolved;
    activeBackend = store.backend;
    return store;
  }

  const composite: SecretStore = {
    get backend(): SecretStoreBackend {
      return activeBackend;
    },

    async isAvailable(): Promise<boolean> {
      try {
        await resolveBackend();
        return true;
      } catch {
        return false;
      }
    },

    async get(name: string): Promise<string | null> {
      const store = await resolveBackend();
      return store.get(name);
    },

    async set(name: string, value: string): Promise<void> {
      const store = await resolveBackend();
      await store.set(name, value);
    },

    async delete(name: string): Promise<boolean> {
      const store = await resolveBackend();
      return store.delete(name);
    },
  };

  return composite;
}
