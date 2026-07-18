import { defineConfig, mergeConfig } from "vitest/config";

import { sharedTestConfig } from "./vitest.shared";

/**
 * Root Vitest config. Running `pnpm test` (→ `vitest run`) from the repo root
 * discovers and executes every test across the workspace in one pass:
 *   - unit + property tests co-located in each package/app `src/`
 *   - the shared `tests/{unit,integration,simulation}` folders
 *
 * Per-package `vitest.config.ts` files extend `vitest.shared.ts` so a package
 * can also be tested in isolation (e.g. `pnpm --filter @cfls/protocol test`).
 */
export default mergeConfig(
  sharedTestConfig,
  defineConfig({
    test: {
      include: [
        "packages/*/src/**/*.{test,spec}.ts",
        "packages/*/tests/**/*.{test,spec}.ts",
        "apps/*/src/**/*.{test,spec}.ts",
        "apps/*/tests/**/*.{test,spec}.ts",
        "tests/**/*.{test,spec}.ts",
      ],
    },
  }),
);
