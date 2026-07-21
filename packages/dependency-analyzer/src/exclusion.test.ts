/**
 * Unit tests for the always-excluded list (task 5.2; design §7.6, Req 19.7,
 * 29.2). Verifies excluded directories, secret files, and binaries are never
 * surfaced for analysis, and that ordinary source is retained.
 */

import { describe, expect, it } from "vitest";

import { filterIncluded, isExcludedPath } from "./exclusion";
import type { RepoRelativeFile } from "./language-analyzer";

describe("isExcludedPath — excluded directories (§7.6)", () => {
  it("excludes package stores, build outputs, caches, vcs, venvs, vendor", () => {
    for (const path of [
      "node_modules/react/index.js",
      "packages/app/node_modules/x/y.ts",
      "dist/index.js",
      "build/main.js",
      "out/bundle.js",
      ".git/HEAD",
      ".cache/data",
      ".coordination/local-api.json",
      ".cfls-cache/session.cache",
      "coverage/lcov.info",
      "vendor/lib.go",
      "venv/lib/site.py",
      ".venv/pyvenv.cfg",
      "__pycache__/mod.pyc",
    ]) {
      expect(isExcludedPath(path)).toBe(true);
    }
  });

  it("keeps ordinary repository-relative source paths", () => {
    for (const path of [
      "src/index.ts",
      "packages/app/src/api.ts",
      "lib/util.js",
      "README.md",
    ]) {
      expect(isExcludedPath(path)).toBe(false);
    }
  });
});

describe("isExcludedPath — secrets and binaries (§7.6)", () => {
  it("excludes dot-env files and their variants", () => {
    for (const path of [".env", ".env.local", "app/.env.production"]) {
      expect(isExcludedPath(path)).toBe(true);
    }
  });

  it("excludes key/cert material and known secret files", () => {
    for (const path of [
      "certs/server.pem",
      "keys/private.key",
      "tls/cert.crt",
      "keystore.p12",
      "config/id_rsa",
      "config/.npmrc",
    ]) {
      expect(isExcludedPath(path)).toBe(true);
    }
  });

  it("excludes binary and asset files", () => {
    for (const path of [
      "assets/logo.png",
      "fonts/inter.woff2",
      "bin/tool.exe",
      "native/addon.node",
      "archive.zip",
    ]) {
      expect(isExcludedPath(path)).toBe(true);
    }
  });
});

describe("filterIncluded", () => {
  it("drops excluded files and keeps the rest, preserving order", () => {
    const files: RepoRelativeFile[] = [
      { path: "src/a.ts", content: "" },
      { path: "node_modules/x/index.js", content: "" },
      { path: ".env", content: "SECRET=1" },
      { path: "src/b.ts", content: "" },
    ];
    expect(filterIncluded(files).map((f) => f.path)).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
  });
});
