/**
 * Public-contract fingerprints — category 4 of the Dependency_Graph
 * (design §7.1; Req 19.2). **Hashes only, never contract contents.**
 *
 * A `Public_Contract_Fingerprint` captures that a public surface exists and a
 * stable hash of it, so the host can detect two members touching the same
 * contract without ever seeing the contract itself (design §7.8, §7.2). The six
 * kinds map to the requirement's contract categories:
 *
 *   - `public_api`         — the exported surface of a package entry file.
 *   - `exported_interface` — the exported surface of a non-entry TS/JS module.
 *   - `db_schema`          — database schema files (Prisma, SQL, …).
 *   - `api_schema`         — API schema files (OpenAPI/Swagger, GraphQL).
 *   - `migration`          — migration files (id = the migration path).
 *   - `build_config`       — build / CI / tooling configuration.
 *
 * For TS/JS surfaces the fingerprint hashes only the sorted list of exported
 * **identifier names** (never bodies). For non-source contracts the fingerprint
 * hashes the file content, which is a hash and is never transmitted verbatim.
 */

import { createHash } from "node:crypto";

import type { PublicContractFingerprint } from "@cfls/protocol";

import { filterIncluded } from "./exclusion";
import { baseName, extName, segments, stripComments } from "./internal";
import type { RepoRelativeFile } from "./language-analyzer";

type ContractKind = PublicContractFingerprint["kind"];

const TS_JS_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

// ---------------------------------------------------------------------------
// Exported-name extraction (metadata only — identifier names, never bodies).
// ---------------------------------------------------------------------------

const EXPORT_DECLARATION =
  /\bexport\s+(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:declare\s+)?(?:const\s+enum|function\s*\*?|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
const EXPORT_NAMED_BLOCK = /\bexport\s*(?:type\s*)?\{([^}]*)\}/g;
const EXPORT_STAR = /\bexport\s*\*\s*(?:as\s+([A-Za-z_$][\w$]*)\s+)?from\b/g;
const EXPORT_DEFAULT_EXPR = /\bexport\s+default\b/g;

/** Parse the inside of an `export { … }` block into its exported names. */
function namesFromBlock(block: string): string[] {
  const names: string[] = [];
  for (const entry of block.split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    // `a as b` exports the alias `b`; a bare `a` exports `a`.
    const asMatch = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(trimmed);
    if (asMatch?.[1]) {
      names.push(asMatch[1]);
      continue;
    }
    const bare = /^([A-Za-z_$][\w$]*)$/.exec(trimmed);
    if (bare?.[1]) names.push(bare[1]);
  }
  return names;
}

/**
 * Extract the sorted, de-duplicated set of exported identifier names from a
 * TS/JS source. Only names are captured — never initializers or bodies.
 */
export function extractExportedNames(source: string): string[] {
  const clean = stripComments(source);
  const names = new Set<string>();

  for (const match of clean.matchAll(EXPORT_DECLARATION)) {
    if (match[1]) names.add(match[1]);
  }
  for (const match of clean.matchAll(EXPORT_NAMED_BLOCK)) {
    for (const name of namesFromBlock(match[1] ?? "")) names.add(name);
  }
  for (const match of clean.matchAll(EXPORT_STAR)) {
    names.add(match[1] ? match[1] : "*");
  }
  // `export default <expr>` (without a named declaration) exports `default`.
  for (const match of clean.matchAll(EXPORT_DEFAULT_EXPR)) {
    const end = (match.index ?? 0) + (match[0]?.length ?? 0);
    const after = clean.slice(end).trimStart();
    if (
      !/^(?:async\s+)?(?:abstract\s+)?(?:function\s*\*?|class)\b/.test(after)
    ) {
      names.add("default");
    }
  }

  return [...names].sort();
}

// ---------------------------------------------------------------------------
// Non-source contract classification.
// ---------------------------------------------------------------------------

function hasSegment(
  path: string,
  predicate: (seg: string) => boolean,
): boolean {
  return segments(path).some(predicate);
}

function isMigrationPath(path: string): boolean {
  return hasSegment(path, (seg) => {
    const lower = seg.toLowerCase();
    return lower === "migrations" || lower === "migration";
  });
}

const DB_SCHEMA_EXTENSIONS: ReadonlySet<string> = new Set([
  ".sql",
  ".prisma",
  ".dbml",
]);
const API_SCHEMA_EXTENSIONS: ReadonlySet<string> = new Set([
  ".graphql",
  ".gql",
]);

function isApiSchemaFile(name: string, ext: string): boolean {
  if (API_SCHEMA_EXTENSIONS.has(ext)) return true;
  const lower = name.toLowerCase();
  return (
    /^(openapi|swagger)\.(json|ya?ml)$/.test(lower) ||
    /\.(openapi|swagger)\.(json|ya?ml)$/.test(lower)
  );
}

const BUILD_CONFIG_NAMES: ReadonlySet<string> = new Set([
  "package.json",
  "tsconfig.json",
  "jsconfig.json",
  "dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "makefile",
  ".gitlab-ci.yml",
  ".eslintrc",
  ".eslintrc.json",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".prettierrc",
  ".prettierrc.json",
  ".babelrc",
  "babel.config.js",
  "turbo.json",
  "pnpm-workspace.yaml",
]);

function isBuildConfigFile(path: string, name: string): boolean {
  const lower = name.toLowerCase();
  if (BUILD_CONFIG_NAMES.has(lower)) return true;
  if (/^tsconfig\..*\.json$/.test(lower)) return true;
  if (/\.config\.[cm]?[jt]s$/.test(lower)) return true;
  // GitHub Actions workflow files.
  return (
    /\.ya?ml$/.test(lower) &&
    hasSegment(path, (seg) => seg === ".github") &&
    hasSegment(path, (seg) => seg === "workflows")
  );
}

/**
 * Classify a file into a non-source contract kind, if any. Priority is
 * migration > db_schema > api_schema > build_config so a schema file inside a
 * migrations folder is reported as a migration, etc. Returns `undefined` when
 * the file is not a non-source contract (it may still be a TS/JS surface).
 */
function classifyNonSource(path: string): ContractKind | undefined {
  const name = baseName(path);
  const ext = extName(path);

  if (isMigrationPath(path)) return "migration";
  if (DB_SCHEMA_EXTENSIONS.has(ext)) return "db_schema";
  if (isApiSchemaFile(name, ext)) return "api_schema";
  if (isBuildConfigFile(path, name)) return "build_config";
  return undefined;
}

const ENTRY_BASENAMES: ReadonlySet<string> = new Set([
  "index.ts",
  "index.tsx",
  "index.mts",
  "index.cts",
  "index.js",
  "index.jsx",
  "index.mjs",
  "index.cjs",
  "main.ts",
  "main.js",
]);

function isTsJsFile(ext: string): boolean {
  return TS_JS_EXTENSIONS.has(ext);
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

/**
 * Extract every {@link PublicContractFingerprint} from `files`, applying the
 * exclusion list first (design §7.6) so secrets/binaries/build outputs are
 * never fingerprinted. Output is sorted by `(kind, id)` for determinism.
 */
export function extractContractFingerprints(
  files: RepoRelativeFile[],
): PublicContractFingerprint[] {
  const included = filterIncluded(files);
  const result: PublicContractFingerprint[] = [];

  for (const file of included) {
    const ext = extName(file.path);
    const nonSource = classifyNonSource(file.path);

    if (nonSource) {
      // Non-source contract: fingerprint is a hash of the file content.
      result.push({
        id: file.path,
        kind: nonSource,
        fingerprint: sha256Hex(file.content),
      });
      continue;
    }

    if (isTsJsFile(ext)) {
      const names = extractExportedNames(file.content);
      if (names.length === 0) continue; // no public surface → no fingerprint
      const kind: ContractKind = ENTRY_BASENAMES.has(baseName(file.path))
        ? "public_api"
        : "exported_interface";
      result.push({
        id: file.path,
        kind,
        // Hash only the sorted exported identifier names — never bodies.
        fingerprint: sha256Hex(JSON.stringify(names)),
      });
    }
  }

  result.sort((a, b) =>
    a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind.localeCompare(b.kind),
  );
  return result;
}

/**
 * The TS/JS-only subset of {@link extractContractFingerprints}, used by the
 * TS/JS analyzer so its {@link AnalyzeResult} carries the exported-surface
 * fingerprints for the language it owns.
 */
export function extractTsJsContracts(
  files: RepoRelativeFile[],
): PublicContractFingerprint[] {
  return extractContractFingerprints(files).filter(
    (c) => c.kind === "public_api" || c.kind === "exported_interface",
  );
}
