/**
 * Per-user login-startup registration for the packaged agent (task 9.7;
 * Req 2.1, 2.2; design "Project Structure" — Packaging).
 *
 * The agent registers itself to start at user login **without administrator
 * privileges** by writing the per-user `HKCU\…\Run` registry key (or, as a
 * fallback, a launcher in the user's Startup folder). Both are user-scoped and
 * require no elevation (Req 2.2). This module builds the exact commands and runs
 * them via an injectable executor so the command construction is unit-testable
 * off-Windows; the registration itself is a no-op on non-Windows platforms
 * (Windows-first, design Non-Goals).
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The HKCU Run key path where per-user startup entries live. */
export const HKCU_RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

/** Default registry value name / Startup launcher basename for the agent. */
export const STARTUP_ENTRY_NAME = "CflsCoordinationAgent";

/** An injectable command executor (returns stdout); defaults to `execFile`. */
export type CommandRunner = (
  file: string,
  args: readonly string[],
) => Promise<string>;

const defaultRunner: CommandRunner = (file, args) =>
  new Promise<string>((resolve, reject) => {
    execFile(file, [...args], (error, stdout) => {
      if (error) {
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });

/** Options for {@link registerLoginStartup}. */
export interface RegisterStartupOptions {
  /** Absolute path to the packaged agent executable to launch at login. */
  exePath: string;
  /** Registry value / launcher name (defaults to {@link STARTUP_ENTRY_NAME}). */
  name?: string;
  /** Injectable runner (tests). */
  runner?: CommandRunner;
  /** Force the Startup-folder strategy instead of the registry (tests/fallback). */
  useStartupFolder?: boolean;
}

/** The outcome of a registration attempt. */
export interface StartupResult {
  registered: boolean;
  strategy: "hkcu-run" | "startup-folder" | "unsupported";
  detail: string;
}

/**
 * Build the `reg.exe add` argument vector that writes the per-user HKCU Run
 * entry (Req 2.2). Pure and testable; the value is quoted so a path with spaces
 * is preserved.
 */
export function buildRunKeyAddArgs(exePath: string, name: string = STARTUP_ENTRY_NAME): string[] {
  return [
    "add",
    HKCU_RUN_KEY,
    "/v",
    name,
    "/t",
    "REG_SZ",
    "/d",
    `"${exePath}"`,
    "/f",
  ];
}

/** Build the `reg.exe delete` argument vector removing the HKCU Run entry. */
export function buildRunKeyDeleteArgs(name: string = STARTUP_ENTRY_NAME): string[] {
  return ["delete", HKCU_RUN_KEY, "/v", name, "/f"];
}

/** The per-user Startup folder path where a launcher `.cmd` can be dropped. */
export function startupFolderPath(): string {
  const appData = process.env["APPDATA"];
  const base =
    appData && appData.length > 0 ? appData : join(homedir(), "AppData", "Roaming");
  return join(base, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
}

/**
 * Register the agent to launch at user login (Req 2.1). On Windows this writes
 * the HKCU Run key (no admin — Req 2.2), or drops a launcher `.cmd` in the
 * Startup folder when {@link RegisterStartupOptions.useStartupFolder} is set. On
 * non-Windows platforms it is a no-op returning `unsupported`.
 */
export async function registerLoginStartup(
  options: RegisterStartupOptions,
): Promise<StartupResult> {
  const name = options.name ?? STARTUP_ENTRY_NAME;

  if (process.platform !== "win32") {
    return {
      registered: false,
      strategy: "unsupported",
      detail: "Login-startup registration is Windows-first (design Non-Goals).",
    };
  }

  if (options.useStartupFolder === true) {
    const dir = startupFolderPath();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const launcher = join(dir, `${name}.cmd`);
    writeFileSync(launcher, `@echo off\r\nstart "" "${options.exePath}"\r\n`, "utf8");
    return {
      registered: true,
      strategy: "startup-folder",
      detail: launcher,
    };
  }

  const runner = options.runner ?? defaultRunner;
  await runner("reg", buildRunKeyAddArgs(options.exePath, name));
  return {
    registered: true,
    strategy: "hkcu-run",
    detail: `${HKCU_RUN_KEY}\\${name}`,
  };
}

/** Remove the agent's per-user login-startup registration. */
export async function unregisterLoginStartup(
  options: { name?: string; runner?: CommandRunner } = {},
): Promise<StartupResult> {
  const name = options.name ?? STARTUP_ENTRY_NAME;
  if (process.platform !== "win32") {
    return { registered: false, strategy: "unsupported", detail: "Non-Windows." };
  }
  const runner = options.runner ?? defaultRunner;
  await runner("reg", buildRunKeyDeleteArgs(name));
  return { registered: false, strategy: "hkcu-run", detail: `removed ${name}` };
}
