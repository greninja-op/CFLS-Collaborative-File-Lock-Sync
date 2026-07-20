/**
 * Pure Local_API settings resolution + `cfls agent` auto-discovery.
 *
 * Kept free of any `vscode` import so it runs under vitest without the VS Code
 * runtime. The thin adapter ({@link ./vscode-adapter}) reads the raw values from
 * VS Code configuration and delegates the discovery logic here.
 *
 * Discovery: when the configured `token` is empty, `cfls agent` is presumed to
 * be running and to have published its loopback URL + per-session token to
 * `<workspaceFolder>/.coordination/local-api.json`. The extension then connects
 * with zero manual settings (Req 3.1). An explicitly configured token always
 * wins, and a missing/malformed discovery file leaves the configured values
 * unchanged.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The Local_API connection settings the extension ultimately uses. */
export interface LocalApiSettings {
  url: string;
  token: string;
  heartbeatIntervalMs: number;
}

/** The raw configured values (from VS Code settings). */
export interface RawLocalApiConfig {
  url: string;
  token: string;
  heartbeatIntervalMs: number;
}

/** Injectable filesystem seam so {@link resolveLocalApiSettings} is unit-testable. */
export interface LocalApiFileReader {
  exists: (path: string) => boolean;
  read: (path: string) => string;
}

const defaultFileReader: LocalApiFileReader = {
  exists: (path) => existsSync(path),
  read: (path) => readFileSync(path, "utf8"),
};

/**
 * Resolve the effective Local_API settings (pure, testable). See the module
 * docblock for the discovery rules.
 */
export function resolveLocalApiSettings(
  raw: RawLocalApiConfig,
  workspaceFolder: string | undefined,
  reader: LocalApiFileReader = defaultFileReader,
): LocalApiSettings {
  if (raw.token !== "" || workspaceFolder === undefined) {
    return { ...raw };
  }
  const discoveryPath = join(
    workspaceFolder,
    ".coordination",
    "local-api.json",
  );
  if (!reader.exists(discoveryPath)) {
    return { ...raw };
  }
  try {
    const parsed: unknown = JSON.parse(reader.read(discoveryPath));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { url?: unknown }).url === "string" &&
      typeof (parsed as { token?: unknown }).token === "string"
    ) {
      const discovered = parsed as { url: string; token: string };
      return {
        url: discovered.url,
        token: discovered.token,
        heartbeatIntervalMs: raw.heartbeatIntervalMs,
      };
    }
  } catch {
    // Malformed discovery file — fall back to the configured values.
  }
  return { ...raw };
}
