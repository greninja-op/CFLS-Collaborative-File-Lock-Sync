// Flat ESLint config (ESLint 9+) for the collaborative-file-lock-sync monorepo.
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    // Never lint build output, deps, or the VS Code extension bundle.
    ignores: ["**/dist/**", "**/node_modules/**", "**/*.tsbuildinfo", "coverage/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  // Keep ESLint out of Prettier's way (formatting is Prettier's job).
  prettier,
);
