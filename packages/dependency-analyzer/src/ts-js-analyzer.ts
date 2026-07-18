/**
 * TypeScript/JavaScript import-graph analyzer (design §7.5, §7.7; Req 19.1,
 * 19.2, 19.6).
 *
 * Extracts directed `Dependency_Edge`s from **import specifiers only** — it
 * never reads or emits file bodies, comments, or string literals beyond the
 * module specifier itself. Confidence is assigned per design §7.5:
 *
 *   - static, resolvable relative imports        → `high`
 *   - aliased / config-resolved imports          → `medium`
 *   - dynamic imports with a static string       → `low`
 *   - dynamic / reflection with a non-literal arg → `unknown` (Req 19.6)
 *
 * Bare package specifiers (e.g. `react`, `@scope/pkg`) resolve into
 * `node_modules`, which is always excluded (design §7.6), so they produce no
 * module edge here — package dependencies are captured separately (task 5.2).
 */

import type {
  Confidence,
  DependencyEdge,
  EdgeKind,
  ModuleDependencyMetadata,
} from "@cfls/protocol";

import { extractTsJsContracts } from "./contracts";
import { dirOf, normalizePath, stripComments } from "./internal";
import type {
  AnalyzeResult,
  LanguageAnalyzer,
  RepoRelativeFile,
} from "./language-analyzer";

/** File extensions this analyzer understands. */
const SUPPORTED_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
] as const;

/** Candidate extensions tried when resolving an extension-less specifier. */
const RESOLUTION_EXTENSIONS = SUPPORTED_EXTENSIONS;

/** Sentinel `to` target for a dynamic dependency with an unknown module. */
export const DYNAMIC_TARGET = "<dynamic>";

/** The syntactic form an import specifier was found in. */
type ImportSyntax = "static" | "type" | "require" | "dynamic";

interface RawImport {
  /** The module specifier, or `null` for a non-literal dynamic import. */
  readonly specifier: string | null;
  readonly syntax: ImportSyntax;
}

// ---------------------------------------------------------------------------
// Path helpers (repo-relative, forward-slash, platform-independent).
// ---------------------------------------------------------------------------

/** Resolve a relative specifier against the importing file's directory. */
function resolveRelative(fromFile: string, specifier: string): string {
  const base = dirOf(fromFile);
  return normalizePath(base === "" ? specifier : `${base}/${specifier}`);
}

/**
 * Resolve an extension-less specifier against the known file set, trying
 * `<path><ext>` then `<path>/index<ext>`. Returns the matched repo-relative
 * path, or `undefined` when nothing matches.
 */
function resolveToKnownFile(
  resolved: string,
  fileSet: ReadonlySet<string>,
): string | undefined {
  if (fileSet.has(resolved)) return resolved;
  for (const ext of RESOLUTION_EXTENSIONS) {
    if (fileSet.has(resolved + ext)) return resolved + ext;
  }
  for (const ext of RESOLUTION_EXTENSIONS) {
    const candidate = `${resolved}/index${ext}`;
    if (fileSet.has(candidate)) return candidate;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Specifier classification.
// ---------------------------------------------------------------------------

type SpecifierCategory = "relative" | "alias" | "bare";

/**
 * Classify a specifier. Relative specifiers point inside the repo; alias
 * specifiers (`@/…`, `~/…`, `~…`) are config-resolved; everything else is a
 * bare package specifier resolving into `node_modules`.
 */
function classifySpecifier(specifier: string): SpecifierCategory {
  if (specifier.startsWith(".")) return "relative";
  if (specifier.startsWith("@/") || specifier.startsWith("~")) return "alias";
  return "bare";
}

const TEST_FILE_PATTERN = /(\.(test|spec)\.[cm]?[jt]sx?$)|(^|\/)__tests__\//;

function isTestFile(path: string): boolean {
  return TEST_FILE_PATTERN.test(path);
}

// ---------------------------------------------------------------------------
// Import-specifier extraction (regex over comment-stripped source).
// ---------------------------------------------------------------------------

const STATIC_IMPORT = /\bimport\s+(type\s+)?[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g;
const SIDE_EFFECT_IMPORT = /\bimport\s+['"]([^'"]+)['"]/g;
const EXPORT_FROM = /\bexport\s+(type\s+)?[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g;
const REQUIRE_CALL = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*([^)]*?)\s*\)/g;
const STRING_LITERAL_ARG = /^['"]([^'"]+)['"]/;

/** Extract every import specifier and the syntactic form it appeared in. */
function extractImports(source: string): RawImport[] {
  const clean = stripComments(source);
  const imports: RawImport[] = [];

  for (const match of clean.matchAll(STATIC_IMPORT)) {
    imports.push({
      specifier: match[2] ?? null,
      syntax: match[1] ? "type" : "static",
    });
  }
  for (const match of clean.matchAll(EXPORT_FROM)) {
    imports.push({
      specifier: match[2] ?? null,
      syntax: match[1] ? "type" : "static",
    });
  }
  for (const match of clean.matchAll(SIDE_EFFECT_IMPORT)) {
    imports.push({ specifier: match[1] ?? null, syntax: "static" });
  }
  for (const match of clean.matchAll(REQUIRE_CALL)) {
    imports.push({ specifier: match[1] ?? null, syntax: "require" });
  }
  for (const match of clean.matchAll(DYNAMIC_IMPORT)) {
    const arg = (match[1] ?? "").trim();
    const literal = STRING_LITERAL_ARG.exec(arg);
    imports.push({
      specifier: literal ? (literal[1] ?? null) : null,
      syntax: "dynamic",
    });
  }

  return imports;
}

// ---------------------------------------------------------------------------
// Edge derivation.
// ---------------------------------------------------------------------------

function edgeKindFor(raw: RawImport, sourceIsTest: boolean): EdgeKind {
  if (raw.syntax === "dynamic") return "dynamic_unknown";
  if (raw.syntax === "type") return "type_only_import";
  if (sourceIsTest) return "test_dependency";
  return "runtime_import";
}

/**
 * Build a `Dependency_Edge` from one raw import, or `undefined` when it should
 * not produce a module edge (bare package specifier).
 */
function toEdge(
  fromFile: string,
  raw: RawImport,
  fileSet: ReadonlySet<string>,
  sourceIsTest: boolean,
): DependencyEdge | undefined {
  const kind = edgeKindFor(raw, sourceIsTest);

  // Non-literal dynamic import / reflection: target unknown (Req 19.6).
  if (raw.specifier === null) {
    return { from: fromFile, to: DYNAMIC_TARGET, kind, confidence: "unknown" };
  }

  const category = classifySpecifier(raw.specifier);
  if (category === "bare") return undefined; // package dep, not a module edge

  if (category === "relative") {
    const resolved = resolveRelative(fromFile, raw.specifier);
    const to = resolveToKnownFile(resolved, fileSet) ?? resolved;
    const confidence: Confidence = raw.syntax === "dynamic" ? "low" : "high";
    return { from: fromFile, to, kind, confidence };
  }

  // Aliased / config-resolved specifier: resolved via config, medium/low.
  const to = normalizePath(raw.specifier);
  const confidence: Confidence = raw.syntax === "dynamic" ? "low" : "medium";
  return { from: fromFile, to, kind, confidence };
}

/** Deduplicate edges by (to, kind, confidence) preserving first-seen order. */
function dedupeEdges(edges: DependencyEdge[]): DependencyEdge[] {
  const seen = new Set<string>();
  const out: DependencyEdge[] = [];
  for (const edge of edges) {
    const key = `${edge.to}\u0000${edge.kind}\u0000${edge.confidence}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(edge);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Analyzer.
// ---------------------------------------------------------------------------

/** The first-party TypeScript/JavaScript import-graph analyzer. */
export class TsJsImportAnalyzer implements LanguageAnalyzer {
  readonly language = "typescript-javascript";
  readonly version = "1.0.0";

  supports(path: string): boolean {
    const lower = path.toLowerCase();
    return SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
  }

  analyze(files: RepoRelativeFile[]): AnalyzeResult {
    const supported = files.filter((file) => this.supports(file.path));
    const fileSet = new Set(supported.map((file) => file.path));
    const modules: ModuleDependencyMetadata[] = [];

    for (const file of supported) {
      const sourceIsTest = isTestFile(file.path);
      const edges: DependencyEdge[] = [];
      for (const raw of extractImports(file.content)) {
        const edge = toEdge(file.path, raw, fileSet, sourceIsTest);
        if (edge) edges.push(edge);
      }
      modules.push({ sourceFile: file.path, edges: dedupeEdges(edges) });
    }

    // Category 4 — hashed public-contract fingerprints for the TS/JS surface
    // (design §7.1, §7.6; task 5.2). Hashes only, never file bodies.
    return { modules, contracts: extractTsJsContracts(supported) };
  }
}

/** Shared default instance of the TS/JS analyzer. */
export const tsJsAnalyzer = new TsJsImportAnalyzer();
