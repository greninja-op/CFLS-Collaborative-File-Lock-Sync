/**
 * OS credential-store adapter (design §8.2).
 *
 * Wraps the Windows Credential Manager (and equivalent OS keychains) through the
 * optional `keytar` native module. `keytar` is intentionally NOT a hard dependency:
 * it is loaded via dynamic import and the adapter degrades gracefully — reporting
 * itself unavailable — when the module is absent or fails to load (e.g. the native
 * binary did not build). This keeps `pnpm --filter @cfls/security build` working
 * without requiring a native toolchain.
 */

import type { SecretStore } from "./secret-store";
import { DEFAULT_SECRET_SERVICE } from "./secret-store";

/**
 * The subset of the `keytar` API this adapter uses. Declared locally so the
 * package type-checks without `@types/keytar` or the module installed.
 */
interface KeytarLike {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

/**
 * Attempt to load `keytar` at runtime. Returns `null` when the module cannot be
 * loaded for any reason (not installed, native binding missing, load error).
 * The result is memoized so we only probe once per process.
 */
let keytarProbe: Promise<KeytarLike | null> | undefined;

function loadKeytar(): Promise<KeytarLike | null> {
  if (keytarProbe === undefined) {
    keytarProbe = (async (): Promise<KeytarLike | null> => {
      try {
        // Indirect specifier prevents bundlers/tsc from treating this optional
        // native module as a required static dependency.
        const moduleName = "keytar";
        const mod: unknown = await import(/* @vite-ignore */ moduleName);
        const candidate = extractKeytar(mod);
        return candidate;
      } catch {
        return null;
      }
    })();
  }
  return keytarProbe;
}

function extractKeytar(mod: unknown): KeytarLike | null {
  const root = mod as { default?: unknown } | undefined;
  const target: unknown = root && "default" in root ? (root.default ?? root) : root;
  if (
    target &&
    typeof (target as KeytarLike).getPassword === "function" &&
    typeof (target as KeytarLike).setPassword === "function" &&
    typeof (target as KeytarLike).deletePassword === "function"
  ) {
    return target as KeytarLike;
  }
  return null;
}

/** Reset the memoized keytar probe. Intended for tests only. */
export function __resetKeytarProbeForTests(): void {
  keytarProbe = undefined;
}

/**
 * Create a {@link SecretStore} backed by the OS credential store via `keytar`.
 * All operations are keyed by `(serviceName, name)`.
 */
export function createOsCredentialStore(serviceName = DEFAULT_SECRET_SERVICE): SecretStore {
  return {
    backend: "os-credential-store",

    async isAvailable(): Promise<boolean> {
      const keytar = await loadKeytar();
      if (keytar === null) return false;
      // A successful (even empty) read against a probe account confirms the
      // backend responds without throwing. We never surface the value.
      try {
        await keytar.getPassword(serviceName, "__cfls_availability_probe__");
        return true;
      } catch {
        return false;
      }
    },

    async get(name: string): Promise<string | null> {
      const keytar = await requireKeytar();
      return keytar.getPassword(serviceName, name);
    },

    async set(name: string, value: string): Promise<void> {
      const keytar = await requireKeytar();
      await keytar.setPassword(serviceName, name, value);
    },

    async delete(name: string): Promise<boolean> {
      const keytar = await requireKeytar();
      return keytar.deletePassword(serviceName, name);
    },
  };
}

async function requireKeytar(): Promise<KeytarLike> {
  const keytar = await loadKeytar();
  if (keytar === null) {
    // Signalled to the composite store, which decides on the fallback / typed error.
    throw new Error("OS credential store (keytar) is not available");
  }
  return keytar;
}
