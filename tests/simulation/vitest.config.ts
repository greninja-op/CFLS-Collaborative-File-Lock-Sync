import { fileURLToPath } from "node:url";

import { defineConfig, mergeConfig } from "vitest/config";

import { sharedTestConfig } from "../../vitest.shared";

/** Resolve a workspace package's TypeScript source entry from this config dir. */
const src = (rel: string): string =>
  fileURLToPath(new URL(rel, import.meta.url));

/**
 * Vitest config for the multi-agent simulation suite. The scenarios drive real
 * WSS connections and awaited convergence, so a generous per-test timeout keeps
 * them robust on slower machines while staying well under a minute.
 *
 * Workspace packages are aliased to their TypeScript SOURCE (not the built
 * `dist`) so the simulation exercises live source — exactly like each package's
 * own unit tests — and needs no rebuild step. It also sidesteps a `node:`-prefix
 * quirk in the bundled `dist` output for `node:sqlite`.
 */
export default mergeConfig(
  sharedTestConfig,
  defineConfig({
    resolve: {
      alias: {
        "@cfls/host": src("../../apps/host/src/index.ts"),
        "@cfls/agent": src("../../apps/agent/src/index.ts"),
        "@cfls/core-state": src("../../packages/core-state/src/index.ts"),
        "@cfls/protocol": src("../../packages/protocol/src/index.ts"),
        "@cfls/security": src("../../packages/security/src/index.ts"),
        "@cfls/mcp-server": src("../../packages/mcp-server/src/index.ts"),
        "@cfls/dependency-analyzer": src(
          "../../packages/dependency-analyzer/src/index.ts",
        ),
      },
    },
    test: {
      name: "@cfls/simulation",
      include: ["*.{test,spec}.ts"],
      testTimeout: 20_000,
      hookTimeout: 20_000,
    },
  }),
);
