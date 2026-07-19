#!/usr/bin/env node
/**
 * Package the `cfls` CLI as a standalone Windows executable (`cfls.exe`) via
 * Node's Single Executable Applications (SEA) feature. The resulting exe runs
 * without a separate Node install and exposes every `cfls` command
 * (admin-init/host/id/invite/join/connect/agent/sync/clone).
 *
 * This is a release-time step (NOT wired into CI). Run on Windows with:
 *   pnpm -C apps/cli package:win
 *
 * Steps (https://nodejs.org/api/single-executable-applications.html):
 *   1. tsup --config tsup.exe.config.ts        → dist-exe/cfls.cjs (single CJS bundle)
 *   2. node --experimental-sea-config sea-config.json → dist-exe/cfls.blob
 *   3. copy the running node binary            → dist-exe/cfls.exe
 *   4. npx postject cfls.exe NODE_SEA_BLOB cfls.blob --sentinel-fuse <fuse>
 */

import { execFileSync, execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, "..");
const outDir = join(appDir, "dist-exe");
const bundlePath = join(outDir, "cfls.cjs");
const blobPath = join(outDir, "cfls.blob");
const exePath = join(outDir, "cfls.exe");
const SENTINEL = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

/** Run the current Node binary with args (handles spaces in paths safely). */
function runNode(args) {
  console.log(`> node ${args.join(" ")}`);
  execFileSync(process.execPath, args, { stdio: "inherit", cwd: appDir });
}

/**
 * Run a shell command. `npx`/`postject` are `.cmd` shims on Windows, which Node
 * only spawns through a shell, so we use `execSync` (cmd.exe) and double-quote
 * any path arguments (the repo path contains spaces).
 */
function runShell(cmd) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: appDir });
}

// 1. Build the single-file CommonJS bundle.
runShell("npx --yes tsup --config tsup.exe.config.ts");
if (!existsSync(bundlePath)) {
  throw new Error(`Expected bundle not found: ${bundlePath}`);
}

// 2. Generate the SEA blob from sea-config.json.
mkdirSync(outDir, { recursive: true });
runNode(["--experimental-sea-config", join(appDir, "sea-config.json")]);
if (!existsSync(blobPath)) {
  throw new Error("SEA blob was not produced.");
}

// 3. Copy the running node binary as the executable base.
copyFileSync(process.execPath, exePath);

// 4. Inject the blob (postject). The copied exe keeps node's signature, which
//    becomes invalid after injection — harmless for internal/team use.
runShell(
  `npx --yes postject "${exePath}" NODE_SEA_BLOB "${blobPath}" --sentinel-fuse ${SENTINEL}`,
);

console.log(`\nBuilt Windows executable: ${exePath}`);
