import { defineConfig } from "tsup";

/**
 * Self-contained CommonJS build used to produce the standalone `cfls.exe`
 * (Node SEA). Unlike the normal ESM library build (`tsup.config.ts`), this:
 *   - emits a SINGLE CommonJS file (Node SEA only supports a CJS `main`),
 *   - bundles every runtime dependency (`@cfls/*` workspace packages + `ws`)
 *     into that one file so the executable needs no `node_modules`,
 *   - keeps only Node built-ins (`node:sqlite`, `node:crypto`, `node:sea`, …)
 *     external — those are provided by the Node runtime baked into the exe.
 *
 * Output: `dist-exe/cfls.cjs` (the SEA config points its `main` here).
 */
export default defineConfig({
  entry: { cfls: "src/exe-entry.ts" },
  format: ["cjs"],
  target: "es2022",
  outDir: "dist-exe",
  clean: true,
  sourcemap: false,
  dts: false,
  bundle: true,
  // Bundle workspace packages + ws into the single file.
  noExternal: [/^@cfls\//, "ws"],
  // In a CJS bundle `import.meta.url` is empty, which breaks patterns like the
  // host's `createRequire(import.meta.url)("node:sqlite")`. Replace every
  // `import.meta.url` with a valid file URL derived from the running executable
  // (`process.execPath` is always an absolute path, in both SEA and plain Node),
  // so `createRequire(...)` can still resolve Node built-ins.
  define: { "import.meta.url": "__cflsImportMetaUrl" },
  banner: {
    js: "const __cflsImportMetaUrl = require('node:url').pathToFileURL(process.execPath).href;",
  },
});
