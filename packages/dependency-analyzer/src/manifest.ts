/**
 * Package/manifest dependency metadata extraction — category 2 of the
 * Dependency_Graph (design §7.1; Req 19.2).
 *
 * Reads `package.json` manifests only for their **declared dependency
 * metadata**: manifest path, package manager (inferred from a sibling
 * lockfile), direct dependency names, declared version ranges, dependency
 * scope, and a hash of the lockfile. It never emits scripts, arbitrary
 * manifest fields, or any file body — only the metadata categories above.
 *
 * One {@link PackageDependencyMetadata} entry is produced per (manifest, scope)
 * pair that declares at least one dependency, so `prod`/`dev`/`peer`/`optional`
 * dependencies stay distinct as the model requires.
 */

import { createHash } from "node:crypto";

import type { PackageDependencyMetadata } from "@cfls/protocol";

import { filterIncluded } from "./exclusion";
import { dirOf } from "./internal";
import type { RepoRelativeFile } from "./language-analyzer";

/** Manifest dependency scope → the model's `scope` discriminant. */
const SCOPE_BY_FIELD: ReadonlyArray<{
  readonly field: string;
  readonly scope: PackageDependencyMetadata["scope"];
}> = [
  { field: "dependencies", scope: "prod" },
  { field: "devDependencies", scope: "dev" },
  { field: "peerDependencies", scope: "peer" },
  { field: "optionalDependencies", scope: "optional" },
];

/** Sibling lockfile name → package manager, in detection-priority order. */
const LOCKFILE_TO_MANAGER: ReadonlyArray<{
  readonly lockfile: string;
  readonly manager: string;
}> = [
  { lockfile: "pnpm-lock.yaml", manager: "pnpm" },
  { lockfile: "yarn.lock", manager: "yarn" },
  { lockfile: "package-lock.json", manager: "npm" },
  { lockfile: "npm-shrinkwrap.json", manager: "npm" },
  { lockfile: "bun.lockb", manager: "bun" },
];

/** Package manager used when no recognized lockfile sits beside the manifest. */
const UNKNOWN_MANAGER = "unknown";

function joinDir(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

/** A record whose values may be anything (result of `JSON.parse`). */
type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Coerce a raw dependency map into a `name → version-range` record of strings,
 * dropping any non-string ranges. Keys are sorted for deterministic output.
 */
function readVersionRanges(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) return {};
  const out: Record<string, string> = {};
  for (const name of Object.keys(raw).sort()) {
    const range = raw[name];
    if (typeof range === "string") out[name] = range;
  }
  return out;
}

/**
 * Detect the package manager and lockfile hash for a manifest by inspecting
 * lockfiles in the same directory. Returns the first match in priority order.
 */
function detectLockfile(
  manifestDir: string,
  byPath: ReadonlyMap<string, RepoRelativeFile>,
): { manager: string; lockfileHash: string } {
  for (const { lockfile, manager } of LOCKFILE_TO_MANAGER) {
    const file = byPath.get(joinDir(manifestDir, lockfile));
    if (file) {
      const lockfileHash = createHash("sha256")
        .update(file.content)
        .digest("hex");
      return { manager, lockfileHash };
    }
  }
  return { manager: UNKNOWN_MANAGER, lockfileHash: "" };
}

/**
 * Extract {@link PackageDependencyMetadata} for every `package.json` in `files`
 * that is not on the exclusion list. Manifests that fail to parse as JSON are
 * skipped (they carry no reliable metadata).
 */
export function extractPackageMetadata(
  files: RepoRelativeFile[],
): PackageDependencyMetadata[] {
  const included = filterIncluded(files);
  const byPath = new Map(included.map((file) => [file.path, file]));
  const manifests = included
    .filter(
      (file) =>
        file.path === "package.json" || file.path.endsWith("/package.json"),
    )
    .sort((a, b) => a.path.localeCompare(b.path));

  const result: PackageDependencyMetadata[] = [];

  for (const manifest of manifests) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(manifest.content);
    } catch {
      continue; // malformed manifest carries no reliable metadata
    }
    if (!isRecord(parsed)) continue;

    const { manager, lockfileHash } = detectLockfile(
      dirOf(manifest.path),
      byPath,
    );

    for (const { field, scope } of SCOPE_BY_FIELD) {
      const declaredVersionRanges = readVersionRanges(parsed[field]);
      const directDependencyNames = Object.keys(declaredVersionRanges);
      if (directDependencyNames.length === 0) continue;

      result.push({
        manifestPath: manifest.path,
        packageManager: manager,
        directDependencyNames,
        declaredVersionRanges,
        scope,
        lockfileHash,
      });
    }
  }

  return result;
}
