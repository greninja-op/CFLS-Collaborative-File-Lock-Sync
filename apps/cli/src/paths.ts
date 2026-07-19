/**
 * Cross-platform path helpers for the CLI (Windows-first; design "Project
 * Structure"). Every path is built with `node:path` + `os.homedir()` so the same
 * code resolves correctly on Windows, macOS, and Linux.
 *
 * Two roots matter:
 *   - `~/.cfls`                — per-user, machine-global config + secrets home
 *     (host admin keys, host.json). NEVER committed.
 *   - `<repoRoot>/.coordination` — per-repository coordination metadata
 *     (agent.json, local-api.json, session.json, rules.json). The runtime files
 *     agent.json + local-api.json are gitignored.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** The per-user cfls home directory: `~/.cfls`. */
export function cflsHomeDir(): string {
  return join(homedir(), ".cfls");
}

/** The host config file path: `~/.cfls/host.json`. */
export function hostConfigPath(): string {
  return join(cflsHomeDir(), "host.json");
}

/** The per-repository `.coordination` directory. */
export function coordinationDir(repoRoot: string): string {
  return join(repoRoot, ".coordination");
}

/** The teammate agent config path: `<repoRoot>/.coordination/agent.json`. */
export function agentConfigPath(repoRoot: string): string {
  return join(coordinationDir(repoRoot), "agent.json");
}

/** The Local_API discovery file: `<repoRoot>/.coordination/local-api.json`. */
export function localApiConfigPath(repoRoot: string): string {
  return join(coordinationDir(repoRoot), "local-api.json");
}

/** The manual session fallback: `<repoRoot>/.coordination/session.json`. */
export function sessionConfigPath(repoRoot: string): string {
  return join(coordinationDir(repoRoot), "session.json");
}
