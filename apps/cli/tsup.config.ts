import { defineConfig } from "tsup";
import { baseTsupOptions } from "../../tsup.config.base";

export default defineConfig({
  ...baseTsupOptions,
  format: ["esm"],
  external: [/^@cfls\//],
  // The published binary needs a Node shebang so `cfls` is directly runnable.
  banner: { js: "#!/usr/bin/env node" },
});
