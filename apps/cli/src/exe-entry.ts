/**
 * Standalone-executable entry point for the `cfls` CLI (Node SEA / single
 * executable). This is bundled to a single CommonJS file by
 * `tsup.exe.config.ts` and embedded into `cfls.exe` by `scripts/build-exe.mjs`.
 *
 * Why a separate entry (instead of reusing `index.ts`'s bottom-of-file guard):
 * the `isInvokedDirectly()` check in `index.ts` compares `import.meta.url` to
 * `argv[1]`, which is meaningless inside a single executable, so `main()` would
 * never run. Here we call it explicitly.
 *
 * Argument layout: Node's SEA sets `process.argv = [exePath, exePath, ...args]`
 * (the runtime path appears twice), so the user arguments start at index 2 —
 * identical to a normal `node script.js <args>` invocation. Hence `slice(2)`.
 */

import { main } from "./index";

void main(process.argv.slice(2)).then(
  (code) => {
    if (code !== 0) {
      process.exitCode = code;
    }
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
