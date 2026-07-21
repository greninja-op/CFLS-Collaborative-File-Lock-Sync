/**
 * Read/write helpers for the CLI's non-secret configuration files (design §9.4).
 *
 * These files contain public coordination metadata — public keys, the team id,
 * the Host_URL, and the member name — plus the short-lived Local_API token used
 * for extension discovery. That token is handled as a secret: it is atomically
 * written with owner-only permissions. Private keys are NEVER written here;
 * they live only in the OS secret store / encrypted-file fallback (see
 * `admin-key.ts` and `@cfls/security`). Every file path is passed explicitly so
 * the round-trip is unit-testable against a temp dir.
 */

import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

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

/**
 * OS-specific protection for the short-lived Local_API discovery token.
 *
 * This is injectable so the Windows branch can be tested on a non-Windows
 * runner. Production callers use the default security implementation.
 */
export interface LocalApiFileSecurity {
  /** The platform whose filesystem access rules should be enforced. */
  readonly platform: NodeJS.Platform;
  /**
   * Replace a Windows file's DACL with a protected, current-user-only ACL.
   * Implementations must throw when they cannot establish that ACL.
   */
  secureWindowsFile(path: string): void;
  /** True only when a Windows file still has the required private ACL. */
  verifyWindowsFile(path: string): boolean;
}

const WINDOWS_DISCOVERY_PATH_ENV = "CFLS_LOCAL_API_DISCOVERY_PATH";

/**
 * The PowerShell programs below are static and passed with -EncodedCommand.
 * The path is passed via a child-only environment variable, never interpolated
 * into a command string, so a repository path cannot inject PowerShell syntax.
 */
const WINDOWS_SET_PRIVATE_ACL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$path = $env:CFLS_LOCAL_API_DISCOVERY_PATH",
  "if ([string]::IsNullOrWhiteSpace($path)) { throw 'Missing Local_API discovery path.' }",
  "$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User",
  "if ($null -eq $current) { throw 'Unable to determine the current Windows user.' }",
  "$acl = New-Object -TypeName System.Security.AccessControl.FileSecurity",
  "$acl.SetOwner($current)",
  "$acl.SetAccessRuleProtection($true, $false)",
  "$rights = [System.Security.AccessControl.FileSystemRights]::FullControl",
  "$allow = [System.Security.AccessControl.AccessControlType]::Allow",
  "$rule = New-Object -TypeName System.Security.AccessControl.FileSystemAccessRule -ArgumentList @($current, $rights, $allow)",
  "$acl.SetAccessRule($rule)",
  "[System.IO.File]::SetAccessControl($path, $acl)",
].join("\n");

/**
 * Verify the security descriptor through Windows' access-control APIs, rather
 * than trying to parse localized icacls output. A valid discovery record:
 *
 * - is owned by the current SID;
 * - has a protected (non-inherited) DACL;
 * - has only explicit Allow rules for that SID; and
 * - gives that SID FullControl.
 */
const WINDOWS_VERIFY_PRIVATE_ACL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$path = $env:CFLS_LOCAL_API_DISCOVERY_PATH",
  "if ([string]::IsNullOrWhiteSpace($path)) { exit 1 }",
  "$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User",
  "if ($null -eq $current) { exit 1 }",
  "$acl = [System.IO.File]::GetAccessControl($path)",
  "$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])",
  "if ($null -eq $owner) { exit 1 }",
  "$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))",
  "$onlyCurrentAllow = @(",
  "  $rules | Where-Object {",
  "    $_.IdentityReference.Value -eq $current.Value -and",
  "    -not $_.IsInherited -and",
  "    $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow",
  "  }",
  ")",
  "$fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl",
  "$hasFullControl = @(",
  "  $onlyCurrentAllow | Where-Object {",
  "    ($_.FileSystemRights -band $fullControl) -eq $fullControl",
  "  }",
  ").Count -gt 0",
  "$isPrivate = (",
  "  $acl.AreAccessRulesProtected -and",
  "  $owner.Value -eq $current.Value -and",
  "  $rules.Count -gt 0 -and",
  "  $onlyCurrentAllow.Count -eq $rules.Count -and",
  "  $hasFullControl",
  ")",
  "if ($isPrivate) { exit 0 }",
  "exit 1",
].join("\n");

function encodedPowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function windowsPowerShellPath(): string {
  const systemRoot = process.env["SystemRoot"] ?? process.env["WINDIR"];
  if (systemRoot === undefined || systemRoot.length === 0) {
    throw new Error("Windows system root is unavailable.");
  }
  return join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

/**
 * Run a static PowerShell program with the discovery path as child-only data.
 * execFileSync deliberately bypasses cmd.exe and a shell. Use the system
 * PowerShell path rather than resolving an executable from PATH.
 */
function runWindowsAclProgram(script: string, path: string): void {
  execFileSync(
    windowsPowerShellPath(),
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      encodedPowerShell(script),
    ],
    {
      env: {
        ...process.env,
        [WINDOWS_DISCOVERY_PATH_ENV]: path,
      },
      stdio: "ignore",
      windowsHide: true,
    },
  );
}

/**
 * Give only the current Windows account control of a discovery record. The
 * caller runs this against the private temporary file before the atomic rename,
 * so a failed ACL setup never publishes a token-bearing target.
 */
function secureWindowsLocalApiFile(path: string): void {
  try {
    runWindowsAclProgram(WINDOWS_SET_PRIVATE_ACL_SCRIPT, path);
  } catch {
    throw new Error(
      "Could not establish a current-user-only Windows ACL for Local_API discovery.",
    );
  }
}

/** Return false rather than trusting a discovery record when ACL inspection fails. */
function verifyWindowsLocalApiFile(path: string): boolean {
  try {
    runWindowsAclProgram(WINDOWS_VERIFY_PRIVATE_ACL_SCRIPT, path);
    return true;
  } catch {
    return false;
  }
}

const defaultLocalApiFileSecurity: LocalApiFileSecurity = {
  platform: process.platform,
  secureWindowsFile: secureWindowsLocalApiFile,
  verifyWindowsFile: verifyWindowsLocalApiFile,
};

/** True when this record uses POSIX owner/group/other file modes. */
function hasPosixFileModes(security: LocalApiFileSecurity): boolean {
  return security.platform !== "win32";
}

function assertPrivateWindowsFile(
  path: string,
  security: LocalApiFileSecurity,
): void {
  if (!security.verifyWindowsFile(path)) {
    throw new Error(
      "Could not verify a current-user-only Windows ACL for Local_API discovery.",
    );
  }
}

/**
 * Read a Local_API discovery record without following a symlink or accepting a
 * record another local account can read/write. The token is intentionally short
 * lived, but it grants access to the live local agent while it is valid.
 */
function readPrivateJsonObject(
  path: string,
  security: LocalApiFileSecurity,
): Record<string, unknown> | null {
  if (!existsSync(path)) {
    return null;
  }

  let fd: number | undefined;
  try {
    // lstat first so a symlink is never accepted as a discovery record. The
    // fstat comparison below also closes the replacement race between lstat and
    // open as far as the portable Node APIs permit.
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink()) {
      return null;
    }
    if (
      hasPosixFileModes(security) &&
      ((before.mode & 0o077) !== 0 || before.uid !== process.getuid?.())
    ) {
      return null;
    }
    if (!hasPosixFileModes(security) && !security.verifyWindowsFile(path)) {
      return null;
    }

    fd = openSync(path, "r");
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      (hasPosixFileModes(security) &&
        ((opened.mode & 0o077) !== 0 || opened.uid !== process.getuid?.()))
    ) {
      return null;
    }
    // The first verification protects the object we lstat'd; this second one
    // makes an ACL change/replacement during open fail closed. A different
    // local account can at most cause a rejected record, never impersonate the
    // current SID required by the verifier.
    if (!hasPosixFileModes(security) && !security.verifyWindowsFile(path)) {
      return null;
    }

    const parsed: unknown = JSON.parse(readFileSync(fd, "utf8"));
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
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

/**
 * Atomically replace a private JSON record. The temporary file is created in
 * the target directory with mode 0600, flushed, then renamed into place so a
 * reader observes either the complete old record or the complete new record.
 */
function writePrivateJson(
  path: string,
  value: unknown,
  security: LocalApiFileSecurity,
): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });

  const temporary = join(
    parent,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let fd: number | undefined;
  let renamed = false;
  let windowsTargetVerified = hasPosixFileModes(security);
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;

    // Establish and verify the private Windows DACL before publication. This
    // preserves the atomic write guarantee: an ACL failure only leaves a
    // private temporary file that the finally block removes.
    if (!hasPosixFileModes(security)) {
      security.secureWindowsFile(temporary);
      assertPrivateWindowsFile(temporary, security);
    }

    // Same-directory rename is atomic on the supported filesystems. Opening
    // the temporary file with 0600 means there is no permissive post-rename
    // window even when the process has a relaxed umask.
    renameSync(temporary, path);
    renamed = true;
    if (hasPosixFileModes(security)) {
      chmodSync(path, 0o600);
    } else {
      assertPrivateWindowsFile(path, security);
      windowsTargetVerified = true;
    }
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
    if (!renamed) {
      try {
        unlinkSync(temporary);
      } catch {
        // The temporary file may not have been created, or the failed rename
        // may already have cleaned it up. Never hide the original write error.
      }
    } else if (!windowsTargetVerified) {
      // The newly published file could not be verified. Remove our target so
      // the caller never leaves a token record available for discovery.
      try {
        unlinkSync(path);
      } catch {
        // A concurrent replacement may already have removed it. Reads still
        // fail closed because they independently validate the owner and DACL.
      }
    }
  }
}

/** Write the Local_API discovery file for the VS Code extension. */
export function writeLocalApiConfig(
  path: string,
  value: LocalApiConfigFile,
  security: LocalApiFileSecurity = defaultLocalApiFileSecurity,
): void {
  writePrivateJson(path, value, security);
}

/**
 * Read the Local_API discovery file, or `null` when absent, invalid, symlinked,
 * or readable/writable by another local account on POSIX.
 */
export function readLocalApiConfig(
  path: string,
  security: LocalApiFileSecurity = defaultLocalApiFileSecurity,
): LocalApiConfigFile | null {
  const raw = readPrivateJsonObject(path, security);
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
