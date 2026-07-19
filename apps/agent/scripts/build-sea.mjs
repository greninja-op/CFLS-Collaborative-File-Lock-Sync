#!/usr/bin/env node
/**
 * Package the CoordinationAgent as a standalone Windows executable via Node SEA
 * (Single Executable Applications), with a `pkg` fallback (task 9.7; Req 2.1,
 * 2.2; design "Project Structure" — Packaging).
 *
 * This produces a self-contained `cfls-agent.exe` that runs without a separate
 * Node install and registers per-user login startup at first run (no admin —
 * Req 2.2). It is intentionally NOT wired into CI: packaging is a release-time
 * step run on a Windows build host. Run with:  `pnpm -C apps/agent package:win`.
 *
 * Steps (Node SEA, https://nodejs.org/api/single-executable-applications.html):
 *   1. `pnpm -C apps/agent build`                    → bundles dist/index.js
 *   2. node --experimental-sea-config sea-config.json → dist/cfls-agent.blob
 *   3. copy the node binary → cfls-agent.exe
 *   4. npx postject cfls-agent.exe NODE_SEA_BLOB dist/cfls-agent.blob \
 *        --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
 *
 * The `pkg` fallback (if SEA is unavailable on the toolchain) is:
 *   npx pkg dist/index.js --targets node20-win-x64 --output dist/cfls-agent.exe
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, "..");
const distDir = join(appDir, "dist");
const exePath = join(distDir, "cfls-agent.exe");
const blobPath = join(distDir, "cfls-agent.blob");
const SENTINEL = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

function run(file, args, opts = {}) {
  console.log(`> ${file} ${args.join(" ")}`);
  execFileSync(file, args, { stdio: "inherit", cwd: appDir, ...opts });
}

function buildBundle() {
  run("pnpm", ["-C", appDir, "build"]);
  if (!existsSync(join(distDir, "index.js"))) {
    throw new Error("Bundle dist/index.js not found after build.");
  }
}

function buildSea() {
  mkdirSync(distDir, { recursive: true });
  buildBundle();
  // 1. Generate the SEA blob from sea-config.json.
  run(process.execPath, ["--experimental-sea-config", join(appDir, "sea-config.json")]);
  if (!existsSync(blobPath)) {
    throw new Error("SEA blob was not produced.");
  }
  // 2. Copy the running node binary as the executable base.
  copyFileSync(process.execPath, exePath);
  // 3. Inject the blob with postject.
  run("npx", [
    "--yes",
    "postject",
    exePath,
    "NODE_SEA_BLOB",
    blobPath,
    "--sentinel-fuse",
    SENTINEL,
  ]);
  console.log(`\nBuilt Windows executable: ${exePath}`);
}

function buildPkgFallback() {
  buildBundle();
  run("npx", [
    "--yes",
    "pkg",
    join(distDir, "index.js"),
    "--targets",
    "node20-win-x64",
    "--output",
    exePath,
  ]);
  console.log(`\nBuilt Windows executable (pkg fallback): ${exePath}`);
}

try {
  buildSea();
} catch (err) {
  console.warn(`\nNode SEA packaging failed (${String(err)}); trying pkg fallback…`);
  buildPkgFallback();
}
