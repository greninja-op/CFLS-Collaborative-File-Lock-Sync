/**
 * Unit tests for the rules-precedence resolver (task 4.12; Req 15.1–15.5).
 */

import { describe, expect, it } from "vitest";

import {
  ALL_SOFT_CONFIG,
  globMatch,
  isRiskLevel,
  mostRestrictive,
  parseRulesConfig,
  resolveMode,
  type RepositoryRulesConfig,
} from "./rules";

const config = (
  rules: RepositoryRulesConfig["rules"],
  defaultMode: RepositoryRulesConfig["defaults"]["mode"] = "soft",
): RepositoryRulesConfig => ({
  version: 1,
  defaults: { mode: defaultMode },
  rules,
});

describe("mostRestrictive (Req 15.4)", () => {
  it("orders hard > coordination-required > soft", () => {
    expect(mostRestrictive(["soft", "hard", "coordination-required"])).toBe("hard");
    expect(mostRestrictive(["soft", "coordination-required"])).toBe("coordination-required");
    expect(mostRestrictive(["soft", "soft"])).toBe("soft");
  });

  it("defaults to soft on empty input", () => {
    expect(mostRestrictive([])).toBe("soft");
  });
});

describe("globMatch", () => {
  it("matches a globstar across nested directories", () => {
    expect(globMatch("src/db/migrations/**", "src/db/migrations/0001_init.sql")).toBe(true);
    expect(globMatch("src/db/migrations/**", "src/db/migrations/a/b/c.sql")).toBe(true);
    expect(globMatch("src/db/migrations/**", "src/db/models/user.ts")).toBe(false);
  });

  it("globstar matches zero intermediate segments", () => {
    expect(globMatch("openapi/**/*.yaml", "openapi/users.yaml")).toBe(true);
    expect(globMatch("openapi/**/*.yaml", "openapi/v1/users.yaml")).toBe(true);
    expect(globMatch("openapi/**/*.yaml", "openapi/v1/users.json")).toBe(false);
  });

  it("single star does not cross a path separator", () => {
    expect(globMatch("src/*.ts", "src/index.ts")).toBe(true);
    expect(globMatch("src/*.ts", "src/nested/index.ts")).toBe(false);
  });

  it("normalizes separators and redundant segments before matching", () => {
    expect(globMatch("docs/**", "docs\\guide\\intro.md")).toBe(true);
    expect(globMatch("docs/**", "./docs/intro.md")).toBe(true);
  });

  it("supports ? for a single character", () => {
    expect(globMatch("v?/api.ts", "v1/api.ts")).toBe(true);
    expect(globMatch("v?/api.ts", "v12/api.ts")).toBe(false);
  });
});

describe("resolveMode", () => {
  it("defaults unmatched paths to soft (Req 15.3)", () => {
    const cfg = config([{ glob: "src/db/**", mode: "hard" }]);
    expect(resolveMode("README.md", cfg)).toBe("soft");
    expect(resolveMode("src/app.ts", cfg)).toBe("soft");
  });

  it("applies the configured mode to a matching path (Req 15.2)", () => {
    const cfg = config([
      { glob: "src/db/migrations/**", mode: "hard" },
      { glob: "openapi/**/*.yaml", mode: "coordination-required" },
    ]);
    expect(resolveMode("src/db/migrations/0001.sql", cfg)).toBe("hard");
    expect(resolveMode("openapi/v1/users.yaml", cfg)).toBe("coordination-required");
  });

  it("picks the most restrictive mode when multiple globs match (Req 15.4)", () => {
    const cfg = config([
      { glob: "src/**", mode: "soft" },
      { glob: "src/db/**", mode: "coordination-required" },
      { glob: "src/db/migrations/**", mode: "hard" },
    ]);
    expect(resolveMode("src/db/migrations/0001.sql", cfg)).toBe("hard");
    expect(resolveMode("src/db/schema.ts", cfg)).toBe("coordination-required");
    expect(resolveMode("src/app.ts", cfg)).toBe("soft");
  });

  it("is independent of rule ordering (Req 15.4)", () => {
    const rules = [
      { glob: "src/db/migrations/**", mode: "hard" as const },
      { glob: "src/**", mode: "soft" as const },
      { glob: "src/db/**", mode: "coordination-required" as const },
    ];
    const forward = config(rules);
    const reversed = config([...rules].reverse());
    const path = "src/db/migrations/0001.sql";
    expect(resolveMode(path, forward)).toBe(resolveMode(path, reversed));
    expect(resolveMode(path, forward)).toBe("hard");
  });

  it("honors a non-soft default mode", () => {
    const cfg = config([{ glob: "docs/**", mode: "soft" }], "coordination-required");
    expect(resolveMode("README.md", cfg)).toBe("coordination-required");
    // The matching soft rule cannot lower below the default (most-restrictive-wins).
    expect(resolveMode("docs/intro.md", cfg)).toBe("coordination-required");
  });

  it("resolves everything to soft under the all-soft fallback", () => {
    expect(resolveMode("src/db/migrations/0001.sql", ALL_SOFT_CONFIG)).toBe("soft");
  });
});

describe("parseRulesConfig", () => {
  it("accepts a well-formed config", () => {
    const result = parseRulesConfig({
      version: 1,
      defaults: { mode: "soft" },
      rules: [
        { glob: "src/db/migrations/**", mode: "hard" },
        { glob: "openapi/**/*.yaml", mode: "coordination-required" },
      ],
    });
    expect(result.malformed).toBe(false);
    expect(result.errors).toHaveLength(0);
    expect(result.config.rules).toHaveLength(2);
    expect(resolveMode("src/db/migrations/1.sql", result.config)).toBe("hard");
  });

  it("defaults the mode to soft when defaults is omitted", () => {
    const result = parseRulesConfig({ version: 1, rules: [] });
    expect(result.malformed).toBe(false);
    expect(result.config.defaults.mode).toBe("soft");
  });

  it("falls back to all-soft on a non-object document (Req 15.5)", () => {
    const result = parseRulesConfig("not a config");
    expect(result.malformed).toBe(true);
    expect(result.config).toBe(ALL_SOFT_CONFIG);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects an unsupported version and falls back to all-soft", () => {
    const result = parseRulesConfig({ version: 2, rules: [] });
    expect(result.malformed).toBe(true);
    expect(result.config).toBe(ALL_SOFT_CONFIG);
    expect(result.errors[0].location).toBe("version");
  });

  it("rejects an invalid mode value and never escalates (Req 15.5)", () => {
    const result = parseRulesConfig({
      version: 1,
      rules: [{ glob: "src/db/**", mode: "block" }],
    });
    expect(result.malformed).toBe(true);
    expect(result.config).toBe(ALL_SOFT_CONFIG);
    // A broken file must not silently escalate any path.
    expect(resolveMode("src/db/migrations/1.sql", result.config)).toBe("soft");
    expect(result.errors.some((e) => e.location === "rules[0].mode")).toBe(true);
  });

  it("rejects an empty or non-string glob and identifies the offending entry", () => {
    const result = parseRulesConfig({
      version: 1,
      rules: [{ glob: "   ", mode: "hard" }],
    });
    expect(result.malformed).toBe(true);
    expect(result.errors.some((e) => e.location === "rules[0].glob")).toBe(true);
  });

  it("rejects a non-array rules field", () => {
    const result = parseRulesConfig({ version: 1, rules: { glob: "x", mode: "hard" } });
    expect(result.malformed).toBe(true);
    expect(result.errors.some((e) => e.location === "rules")).toBe(true);
  });

  it("collects multiple errors across malformed entries", () => {
    const result = parseRulesConfig({
      version: 1,
      rules: [
        { glob: "ok/**", mode: "hard" },
        { glob: 42, mode: "nope" },
      ],
    });
    expect(result.malformed).toBe(true);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe("isRiskLevel", () => {
  it("recognizes valid modes and rejects others", () => {
    expect(isRiskLevel("soft")).toBe(true);
    expect(isRiskLevel("coordination-required")).toBe(true);
    expect(isRiskLevel("hard")).toBe(true);
    expect(isRiskLevel("block")).toBe(false);
    expect(isRiskLevel(undefined)).toBe(false);
  });
});
