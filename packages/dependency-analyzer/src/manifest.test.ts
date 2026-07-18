/**
 * Unit tests for package/manifest dependency-metadata extraction (task 5.2;
 * design §7.1, Req 19.2). Covers scope splitting, package-manager detection
 * from sibling lockfiles, lockfile hashing, exclusion, and malformed manifests.
 */

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { extractPackageMetadata } from "./manifest";
import type { RepoRelativeFile } from "./language-analyzer";

function file(path: string, content: string): RepoRelativeFile {
  return { path, content };
}

function pkg(deps: Record<string, unknown>): string {
  return JSON.stringify({ name: "demo", version: "1.0.0", ...deps });
}

describe("extractPackageMetadata — scopes", () => {
  it("produces one entry per declared dependency scope", () => {
    const result = extractPackageMetadata([
      file(
        "package.json",
        pkg({
          dependencies: { react: "^18.0.0" },
          devDependencies: { vitest: "^3.0.0", typescript: "~5.7.0" },
          peerDependencies: { react: ">=17" },
          optionalDependencies: { fsevents: "^2.0.0" },
        }),
      ),
    ]);

    const byScope = Object.fromEntries(result.map((m) => [m.scope, m]));
    expect(new Set(result.map((m) => m.scope))).toEqual(
      new Set(["prod", "dev", "peer", "optional"]),
    );
    expect(byScope.dev?.directDependencyNames).toEqual(["typescript", "vitest"]);
    expect(byScope.dev?.declaredVersionRanges).toEqual({
      typescript: "~5.7.0",
      vitest: "^3.0.0",
    });
    expect(byScope.prod?.declaredVersionRanges).toEqual({ react: "^18.0.0" });
  });

  it("omits scopes with no dependencies", () => {
    const result = extractPackageMetadata([
      file("package.json", pkg({ dependencies: { react: "^18.0.0" } })),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.scope).toBe("prod");
  });

  it("returns nothing for a manifest with no dependencies", () => {
    expect(extractPackageMetadata([file("package.json", pkg({}))]).length).toBe(
      0,
    );
  });
});

describe("extractPackageMetadata — package manager detection", () => {
  it("detects pnpm/yarn/npm from a sibling lockfile and hashes it", () => {
    const lock = "lockfile-contents";
    const expectedHash = createHash("sha256").update(lock).digest("hex");

    const npm = extractPackageMetadata([
      file("package.json", pkg({ dependencies: { a: "1" } })),
      file("package-lock.json", lock),
    ]);
    expect(npm[0]?.packageManager).toBe("npm");
    expect(npm[0]?.lockfileHash).toBe(expectedHash);

    const yarn = extractPackageMetadata([
      file("package.json", pkg({ dependencies: { a: "1" } })),
      file("yarn.lock", lock),
    ]);
    expect(yarn[0]?.packageManager).toBe("yarn");

    const pnpm = extractPackageMetadata([
      file("package.json", pkg({ dependencies: { a: "1" } })),
      file("pnpm-lock.yaml", lock),
    ]);
    expect(pnpm[0]?.packageManager).toBe("pnpm");
  });

  it("falls back to unknown with an empty hash when no lockfile is present", () => {
    const result = extractPackageMetadata([
      file("package.json", pkg({ dependencies: { a: "1" } })),
    ]);
    expect(result[0]?.packageManager).toBe("unknown");
    expect(result[0]?.lockfileHash).toBe("");
  });

  it("matches lockfiles only in the manifest's own directory", () => {
    const result = extractPackageMetadata([
      file("apps/web/package.json", pkg({ dependencies: { a: "1" } })),
      file("apps/web/pnpm-lock.yaml", "x"),
      file("package-lock.json", "root"),
    ]);
    expect(result[0]?.manifestPath).toBe("apps/web/package.json");
    expect(result[0]?.packageManager).toBe("pnpm");
  });
});

describe("extractPackageMetadata — robustness and exclusion", () => {
  it("skips manifests that are not valid JSON", () => {
    expect(
      extractPackageMetadata([file("package.json", "{ not json ")]),
    ).toEqual([]);
  });

  it("never reads manifests under excluded directories", () => {
    const result = extractPackageMetadata([
      file("node_modules/react/package.json", pkg({ dependencies: { x: "1" } })),
    ]);
    expect(result).toEqual([]);
  });

  it("does not leak arbitrary manifest fields (scripts) into metadata", () => {
    const manifest = JSON.stringify({
      name: "demo",
      scripts: { build: "secret-build-command" },
      dependencies: { a: "1" },
    });
    const serialized = JSON.stringify(
      extractPackageMetadata([file("package.json", manifest)]),
    );
    expect(serialized).not.toContain("secret-build-command");
  });
});
