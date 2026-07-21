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

import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
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

/**
 * A reader that returns discovery contents only after enforcing the private
 * file checks. It deliberately does not expose a raw JSON-file read, so the
 * extension's production discovery path cannot bypass those checks.
 */
export interface LocalApiFileReader {
  readPrivateDiscovery: (path: string) => string | null;
}

/**
 * OS-specific verification for the token-bearing discovery record. The
 * interface is injectable so the Windows path is unit-tested without a Windows
 * host.
 */
export interface LocalApiDiscoverySecurity {
  readonly platform: NodeJS.Platform;
  /** True only when the file has the required current-user-only Windows ACL. */
  verifyWindowsFile(path: string): boolean;
}

const WINDOWS_DISCOVERY_PATH_ENV = "CFLS_LOCAL_API_DISCOVERY_PATH";

/**
 * Use Windows access-control APIs rather than parsing localized icacls output.
 * This static script is encoded before execution; the path is passed through a
 * child-only environment variable and is never interpolated into PowerShell.
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

function verifyWindowsLocalApiFile(path: string): boolean {
  try {
    execFileSync(
      windowsPowerShellPath(),
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        encodedPowerShell(WINDOWS_VERIFY_PRIVATE_ACL_SCRIPT),
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
    return true;
  } catch {
    return false;
  }
}

const defaultDiscoverySecurity: LocalApiDiscoverySecurity = {
  platform: process.platform,
  verifyWindowsFile: verifyWindowsLocalApiFile,
};

function hasPosixFileModes(security: LocalApiDiscoverySecurity): boolean {
  return security.platform !== "win32";
}

/**
 * Read a discovery file only when it is a regular, owner-private record.
 *
 * On POSIX that means mode 0600-or-stricter and the current uid. On Windows it
 * means a protected DACL owned by the current SID with no ACE for another
 * identity. The verifier is applied before and after opening the file; a
 * replacement/ACL race therefore fails closed.
 */
export function readPrivateLocalApiDiscovery(
  path: string,
  security: LocalApiDiscoverySecurity = defaultDiscoverySecurity,
): string | null {
  if (!existsSync(path)) {
    return null;
  }

  let fd: number | undefined;
  try {
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
    if (!hasPosixFileModes(security) && !security.verifyWindowsFile(path)) {
      return null;
    }
    return readFileSync(fd, "utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

const defaultFileReader: LocalApiFileReader = {
  readPrivateDiscovery: readPrivateLocalApiDiscovery,
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
  const discoveredContents = reader.readPrivateDiscovery(discoveryPath);
  if (discoveredContents === null) {
    return { ...raw };
  }
  try {
    const parsed: unknown = JSON.parse(discoveredContents);
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
