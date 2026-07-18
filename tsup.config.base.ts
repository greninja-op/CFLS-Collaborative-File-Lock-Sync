import { defineConfig, type Options } from "tsup";

/**
 * Shared tsup build options for every package/app in the monorepo.
 * Individual packages import this and override as needed (e.g. the VS Code
 * extension builds CJS only, apps mark node built-ins external).
 */
export const baseTsupOptions: Options = {
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  // The shared tsconfig enables `composite`/`incremental` for `tsc -b` project
  // references; those options are invalid for tsup's bundled .d.ts emit, so we
  // turn them off just for the declaration build.
  dts: {
    compilerOptions: {
      composite: false,
      incremental: false,
    },
  },
  sourcemap: true,
  clean: true,
  target: "es2022",
  outDir: "dist",
};

export default defineConfig(baseTsupOptions);
