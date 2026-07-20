/**
 * Small runtime helpers shared by the CLI commands: locating the repository
 * root, minimal argv parsing, secret-safe logging, and a Ctrl+C wait loop for
 * the long-running `host`/`agent` commands.
 */

import { defaultGitRunner, type GitRunner } from "./git";

/**
 * Resolve the repository root. Prefers `git rev-parse --show-toplevel`; falls
 * back to `cwd` when the directory is not a git repository (the manual
 * `.coordination/*` fallback still works relative to `cwd`).
 */
export function resolveRepoRoot(
  cwd: string,
  runner: GitRunner = defaultGitRunner,
): string {
  const top = runner(["rev-parse", "--show-toplevel"], cwd);
  return top.ok && top.stdout !== "" ? top.stdout : cwd;
}

/** A parsed argv: positional args plus `--flag value` / boolean `--flag` options. */
export interface ParsedArgs {
  positionals: string[];
  options: Record<string, string | boolean>;
}

/**
 * Parse a command's argument list. `--flag value` captures the value; a `--flag`
 * followed by another flag (or nothing) is a boolean `true`. `--flag=value` is
 * also supported.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const options: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        options[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        options[body] = next;
        i += 1;
      } else {
        options[body] = true;
      }
    } else {
      positionals.push(token);
    }
  }
  return { positionals, options };
}

/** Read a string option, or `undefined` when absent/boolean. */
export function stringOption(
  args: ParsedArgs,
  name: string,
): string | undefined {
  const value = args.options[name];
  return typeof value === "string" ? value : undefined;
}

/** Read a boolean flag (present as `--flag` or `--flag=true`). */
export function boolOption(args: ParsedArgs, name: string): boolean {
  const value = args.options[name];
  return value === true || value === "true";
}

/** Structured, secret-safe console logging. */
export const log = {
  info: (message: string): void => console.log(message),
  warn: (message: string): void => console.warn(`WARNING: ${message}`),
  error: (message: string): void => console.error(`ERROR: ${message}`),
};

/**
 * Block until the process receives SIGINT/SIGTERM, then run `onStop` and exit.
 * Used by the long-running `host` and `agent` commands so Ctrl+C shuts down
 * cleanly (Req: stop the host/agent on SIGINT).
 */
export async function waitForShutdown(
  onStop: () => Promise<void>,
): Promise<void> {
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      log.info("\nShutting down…");
      void onStop().finally(() => resolve());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
