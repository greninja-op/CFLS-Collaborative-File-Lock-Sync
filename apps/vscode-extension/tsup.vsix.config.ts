import { defineConfig } from "tsup";

/**
 * Self-contained build for packaging a standalone `.vsix` (installable into a
 * normal VS Code, so teammates can be opened as ordinary windows instead of the
 * single reused Extension Development Host).
 *
 * Unlike the dev build, this bundles the workspace `@cfls/*` packages (and all
 * other deps) INTO dist/index.js, leaving only `vscode` external — so the
 * installed extension needs no node_modules.
 */
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs"],
  target: "es2022",
  outDir: "dist",
  clean: true,
  sourcemap: false,
  dts: false,
  external: ["vscode"],
  // Bundle every runtime dependency (the `@cfls/*` workspace packages and `ws`)
  // so the installed extension needs no node_modules.
  noExternal: [/^@cfls\//, "ws"],
});
