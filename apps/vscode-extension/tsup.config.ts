import { defineConfig } from "tsup";
import { baseTsupOptions } from "../../tsup.config.base";

export default defineConfig({
  ...baseTsupOptions,
  // VS Code loads a CommonJS entry point and provides `vscode` at runtime.
  format: ["cjs"],
  external: ["vscode", /^@cfls\//],
});
