/**
 * Read/write helpers for the CLI's non-secret configuration files (design §9.4).
 *
 * These files contain ONLY non-secret coordination metadata — public keys, the
 * team id, the Host_URL, the member name, and the loopback Local_API address +
 * per-session Local_Auth_Token. Private keys are NEVER written here; they live
 * only in the OS secret store / encrypted-file fallback (see `admin-key.ts` and
 * `@cfls/security`). All writes are pretty-printed JSON and every file path is
 * passed explicitly so the round-trip is unit-testable against a temp dir.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** `~/.cfls/host.json` — the host's authorized admin keys + team id. */
export interface HostConfigFile {
  /** Team_Admin `Device_Public_Key`s permitted to issue invitations (Req 5.5). */
  authorizedAdminPublicKeys: string[];
  /** The team id this host serves. */
  teamId: string;
}

/** `<repoRoot>/.coordination/agent.json` — a teammate's saved join state. */
export interface AgentConfigFile {
  /** The Host_URL to connect to (`wss://…`). */
  hostUrl?: string;
  /** The member name this device joins as. */
  memberName?: string;
  /** The team id (must match the host's team id). */
  teamId?: string;
  /** base64(JSON(SignedInvitation)) stored by `cfls connect`. */
  invitation?: string;
}

/** `<repoRoot>/.coordination/local-api.json` — extension auto-discovery. */
export interface LocalApiConfigFile {
  /** Loopback Local_API URL, e.g. `ws://127.0.0.1:8750`. */
  url: string;
  /** The per-session Local_Auth_Token. */
  token: string;
}

/**
 * The optional, team-shared, committed `autoSync` block of
 * `<repoRoot>/.coordination/config.json`. This layers an OPT-IN, per-user-branch
 * automatic git sync (Model A) on top of the metadata-only coordination. It is
 * DISABLED by default so existing behavior is unchanged unless a team opts in.
 * It holds ONLY non-secret settings — never tokens, keys, or credentials.
 */
export interface AutoSyncConfig {
  /** Master switch. When `false` (default) nothing new runs. */
  enabled: boolean;
  /** The git remote to fetch/push against (default `origin`). */
  remote: string;
  /** Branch namespace for per-user publish branches (default `cfls/`). */
  branchPrefix: string;
  /** Seconds between producer commit/push attempts (default `20`). */
  commitIntervalSec: number;
  /** Seconds between consumer fetch/notify cycles (default `20`). */
  fetchIntervalSec: number;
  /**
   * When `true`, the consumer attempts a conflict-free (fast-forward / clean)
   * merge of an advanced teammate branch; on any conflict it aborts and only
   * notifies. Never auto-resolves conflicts. Default `false`.
   */
  autoMerge: boolean;
}

/** `<repoRoot>/.coordination/config.json` — the committed, team-shared config. */
export interface TeamConfigFile {
  /** Optional automatic git sync settings (Model A). Absent ⇒ disabled defaults. */
  autoSync?: Partial<AutoSyncConfig>;
}

/** The safe defaults for {@link AutoSyncConfig}: opt-in disabled (never runs). */
export const DEFAULT_AUTO_SYNC: AutoSyncConfig = {
  enabled: false,
  remote: "origin",
  branchPrefix: "cfls/",
  commitIntervalSec: 20,
  fetchIntervalSec: 20,
  autoMerge: false,
};

/** Parse a JSON file into an object, or `null` when absent/unparseable. */
function readJsonObject(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** Write `value` as pretty JSON, creating the parent directory as needed. */
function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// host.json
// ---------------------------------------------------------------------------

/** Read `~/.cfls/host.json`, or `null` when it does not exist. */
export function readHostConfig(path: string): HostConfigFile | null {
  const raw = readJsonObject(path);
  if (raw === null) {
    return null;
  }
  const keys = Array.isArray(raw["authorizedAdminPublicKeys"])
    ? (raw["authorizedAdminPublicKeys"] as unknown[]).filter(
        (k): k is string => typeof k === "string",
      )
    : [];
  const teamId = typeof raw["teamId"] === "string" ? raw["teamId"] : "";
  return { authorizedAdminPublicKeys: keys, teamId };
}

/**
 * Append an admin public key to `~/.cfls/host.json` (deduplicated) and set the
 * team id, creating the file on first use. Returns the resulting config.
 */
export function appendAdminPublicKey(
  path: string,
  adminPublicKey: string,
  teamId: string,
): HostConfigFile {
  const existing = readHostConfig(path) ?? {
    authorizedAdminPublicKeys: [],
    teamId,
  };
  const keys = new Set(existing.authorizedAdminPublicKeys);
  keys.add(adminPublicKey);
  const next: HostConfigFile = {
    authorizedAdminPublicKeys: [...keys],
    teamId,
  };
  writeJson(path, next);
  return next;
}

// ---------------------------------------------------------------------------
// agent.json
// ---------------------------------------------------------------------------

/** Read `<repoRoot>/.coordination/agent.json`, or `{}` when absent. */
export function readAgentConfig(path: string): AgentConfigFile {
  const raw = readJsonObject(path);
  if (raw === null) {
    return {};
  }
  const out: AgentConfigFile = {};
  if (typeof raw["hostUrl"] === "string") out.hostUrl = raw["hostUrl"];
  if (typeof raw["memberName"] === "string") out.memberName = raw["memberName"];
  if (typeof raw["teamId"] === "string") out.teamId = raw["teamId"];
  if (typeof raw["invitation"] === "string") out.invitation = raw["invitation"];
  return out;
}

/** Merge `patch` into the existing agent config and persist it. */
export function updateAgentConfig(
  path: string,
  patch: AgentConfigFile,
): AgentConfigFile {
  const merged: AgentConfigFile = { ...readAgentConfig(path), ...patch };
  writeJson(path, merged);
  return merged;
}

// ---------------------------------------------------------------------------
// local-api.json
// ---------------------------------------------------------------------------

/** Write the Local_API discovery file for the VS Code extension. */
export function writeLocalApiConfig(
  path: string,
  value: LocalApiConfigFile,
): void {
  writeJson(path, value);
}

/** Read the Local_API discovery file, or `null` when absent/invalid. */
export function readLocalApiConfig(path: string): LocalApiConfigFile | null {
  const raw = readJsonObject(path);
  if (raw === null) {
    return null;
  }
  if (typeof raw["url"] !== "string" || typeof raw["token"] !== "string") {
    return null;
  }
  return { url: raw["url"], token: raw["token"] };
}

// ---------------------------------------------------------------------------
// config.json (team-shared, committed) — autoSync block
// ---------------------------------------------------------------------------

/** Coerce an unknown to a positive integer, or fall back to `fallback`. */
function positiveIntOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

/** Coerce an unknown to a non-empty string, or fall back to `fallback`. */
function nonEmptyStringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

/**
 * Read the effective {@link AutoSyncConfig} from `<repoRoot>/.coordination/config.json`.
 *
 * This ALWAYS returns a fully-populated config: when the file, the `autoSync`
 * block, or any individual field is absent/invalid the corresponding
 * {@link DEFAULT_AUTO_SYNC} value is substituted. Because the default is
 * `enabled: false`, a missing or partial config is a safe no-op — the automatic
 * git sync layer only runs when a team explicitly opts in.
 */
export function readAutoSyncConfig(path: string): AutoSyncConfig {
  const raw = readJsonObject(path);
  const block =
    raw !== null &&
    typeof raw["autoSync"] === "object" &&
    raw["autoSync"] !== null &&
    !Array.isArray(raw["autoSync"])
      ? (raw["autoSync"] as Record<string, unknown>)
      : {};

  return {
    enabled: block["enabled"] === true,
    remote: nonEmptyStringOr(block["remote"], DEFAULT_AUTO_SYNC.remote),
    branchPrefix: nonEmptyStringOr(
      block["branchPrefix"],
      DEFAULT_AUTO_SYNC.branchPrefix,
    ),
    commitIntervalSec: positiveIntOr(
      block["commitIntervalSec"],
      DEFAULT_AUTO_SYNC.commitIntervalSec,
    ),
    fetchIntervalSec: positiveIntOr(
      block["fetchIntervalSec"],
      DEFAULT_AUTO_SYNC.fetchIntervalSec,
    ),
    autoMerge: block["autoMerge"] === true,
  };
}

/** Read the whole team config file, or `{}` when absent/invalid. */
export function readTeamConfig(path: string): TeamConfigFile {
  const raw = readJsonObject(path);
  if (raw === null) {
    return {};
  }
  const out: TeamConfigFile = {};
  if (
    typeof raw["autoSync"] === "object" &&
    raw["autoSync"] !== null &&
    !Array.isArray(raw["autoSync"])
  ) {
    out.autoSync = raw["autoSync"] as Partial<AutoSyncConfig>;
  }
  return out;
}
