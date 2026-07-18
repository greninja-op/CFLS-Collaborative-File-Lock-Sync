/**
 * Unit tests for repository-relative path normalization (Req 10.3–10.4; §9.3).
 * Covers separator unification, `.`/`..`/`./` resolution, and the platform-aware
 * case-matching key on case-insensitive vs case-sensitive platforms.
 */

import { describe, expect, it } from "vitest";

import {
  defaultCaseSensitivity,
  normalizePath,
  normalizePathKey,
  pathMatchKey,
} from "./path";

describe("normalizePath", () => {
  it("converts Windows separators to forward slashes", () => {
    expect(normalizePath("src\\api\\index.ts")).toBe("src/api/index.ts");
  });

  it("strips a leading ./", () => {
    expect(normalizePath("./src/api.ts")).toBe("src/api.ts");
  });

  it("drops redundant . and empty segments", () => {
    expect(normalizePath("src/./api//index.ts")).toBe("src/api/index.ts");
  });

  it("resolves .. segments within the tree", () => {
    expect(normalizePath("src/utils/../api.ts")).toBe("src/api.ts");
    expect(normalizePath("a/b/c/../../d.ts")).toBe("a/d.ts");
  });

  it("maps all equivalent spellings of one path to a single key", () => {
    const canonical = "src/api.ts";
    for (const spelling of [
      "src/api.ts",
      "./src/api.ts",
      "src\\api.ts",
      "src/./api.ts",
      "src/x/../api.ts",
      "src//api.ts",
    ]) {
      expect(normalizePath(spelling)).toBe(canonical);
    }
  });

  it("retains .. that escapes the root as leading .. (deterministic)", () => {
    expect(normalizePath("../outside.ts")).toBe("../outside.ts");
    expect(normalizePath("a/../../b.ts")).toBe("../b.ts");
  });

  it("normalizes an empty or dot path to the empty root", () => {
    expect(normalizePath("")).toBe("");
    expect(normalizePath(".")).toBe("");
    expect(normalizePath("./")).toBe("");
  });
});

describe("defaultCaseSensitivity", () => {
  it("treats win32 and darwin as case-insensitive", () => {
    expect(defaultCaseSensitivity("win32")).toBe("case-insensitive");
    expect(defaultCaseSensitivity("darwin")).toBe("case-insensitive");
  });

  it("treats linux as case-sensitive", () => {
    expect(defaultCaseSensitivity("linux")).toBe("case-sensitive");
  });
});

describe("pathMatchKey", () => {
  it("case-folds on case-insensitive platforms", () => {
    expect(pathMatchKey("Src/Api.TS", "case-insensitive")).toBe("src/api.ts");
  });

  it("preserves case on case-sensitive platforms", () => {
    expect(pathMatchKey("Src/Api.TS", "case-sensitive")).toBe("Src/Api.TS");
  });

  it("maps case variants to one key only when case-insensitive", () => {
    const a = "src/API.ts";
    const b = "src/api.ts";
    expect(pathMatchKey(a, "case-insensitive")).toBe(
      pathMatchKey(b, "case-insensitive"),
    );
    expect(pathMatchKey(a, "case-sensitive")).not.toBe(
      pathMatchKey(b, "case-sensitive"),
    );
  });
});

describe("normalizePathKey", () => {
  it("normalizes then applies the platform-aware case key", () => {
    expect(normalizePathKey("./Src\\API.ts", "case-insensitive")).toBe(
      "src/api.ts",
    );
    expect(normalizePathKey("./Src\\API.ts", "case-sensitive")).toBe(
      "Src/API.ts",
    );
  });
});
