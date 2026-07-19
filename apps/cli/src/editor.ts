/**
 * Best-effort editor launcher for interactive conflict resolution.
 *
 * When `cfls sync merge <member> --resolve` leaves conflict markers in the
 * working tree, we try to open the conflicted files in a graphical editor so the
 * user can use its 3-way merge UI (VS Code / Kiro both show a "Resolve in Merge
 * Editor" affordance when a conflicted file is opened). This is purely a
 * convenience: if no editor CLI is on PATH we simply report that and the user
 * opens the files themselves. The actual launch is injectable so it is unit
 * testable without spawning anything.
 */

import { execFileSync } from "node:child_process";

/** Launch `cmd args` in `cwd`; returns true on success, false on any failure. */
export type Launcher = (cmd: string, args: readonly string[], cwd: string) => boolean;

/** The editor CLIs we try, in order. Both open files in an existing window. */
export const EDITOR_COMMANDS: readonly string[] = ["code", "kiro"];

/** The default launcher: spawn the command synchronously, swallowing output. */
export const defaultLauncher: Launcher = (cmd, args, cwd) => {
  try {
    execFileSync(cmd, [...args], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

/** The command name that successfully opened the files (or `null` if none did). */
export function openInEditor(
  files: readonly string[],
  cwd: string,
  launcher: Launcher = defaultLauncher,
  commands: readonly string[] = EDITOR_COMMANDS,
): string | null {
  if (files.length === 0) {
    return null;
  }
  // `-r` reuses the current window; opening a conflicted file surfaces the
  // editor's merge-conflict UI automatically.
  for (const cmd of commands) {
    if (launcher(cmd, ["-r", ...files], cwd)) {
      return cmd;
    }
  }
  return null;
}
