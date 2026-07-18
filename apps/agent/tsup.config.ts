import { defineConfig } from "tsup";
import { baseTsupOptions } from "../../tsup.config.base";

export default defineConfig({
  ...baseTsupOptions,
  format: ["esm"],
  external: [/^@cfls\//],
});
