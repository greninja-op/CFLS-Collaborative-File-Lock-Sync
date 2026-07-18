/**
 * Repository rules-precedence resolver (Req 15.1–15.5; design "Repository Rules
 * Config Format", §6).
 *
 * A team shares a committed `Repository_Rules_Config` (canonically
 * `.coordination/rules.yaml` at the repository root) that maps path globs to a
 * coordination {@link RiskLevel} mode of `hard | coordination-required | soft`
 * (Req 15.1). This module owns the *pure* policy logic that turns that config
 * into a per-path mode decision:
 *
 *   - {@link resolveMode} resolves a repository-relative path to a mode using
 *     **most-restrictive-wins** across every matching glob, ordering
 *     `hard > coordination-required > soft` (Req 15.4), and defaulting any path
 *     that matches no glob to `soft` (Req 15.3).
 *   - {@link parseRulesConfig} validates a *deserialized* config document and,
 *     if anything is malformed, reports the offending content and **falls back
 *     to all-soft** so a broken file can never silently escalate a path to
 *     `hard`/`coordination-required` (Req 15.5, fail-safe).
 *
 * The YAML *text* is deserialized upstream by the CoordinationAgent (task 9.6);
 * `@cfls/core-state` is intentionally dependency-free and pure, so this module
 * validates the already-parsed document (an `unknown` value) rather than reading
 * files or parsing YAML itself.
 */

import type { RiskLevel } from "@cfls/protocol";

import { normalizePath } from "./path";

/** A single glob → mode mapping in a {@link RepositoryRulesConfig} (Req 15.1). */
export interface RepositoryRuleEntry {
  /** A path glob (`*`, `?`, and `**` supported) relative to the repo root. */
  readonly glob: string;
  /** The coordination mode applied to paths matching {@link glob}. */
  readonly mode: RiskLevel;
}

/**
 * A validated Repository_Rules_Config (design "Repository Rules Config Format").
 * Deserialized from `.coordination/rules.yaml`; only ever produced by
 * {@link parseRulesConfig} so callers can trust its shape.
 */
export interface RepositoryRulesConfig {
  /** Config schema version. The MVP supports version `1`. */
  readonly version: number;
  /** Mode applied to any path matching no rule glob (Req 15.3). */
  readonly defaults: { readonly mode: RiskLevel };
  /** Ordered list of glob → mode rules; order does not affect resolution. */
  readonly rules: readonly RepositoryRuleEntry[];
}

/** A single validation problem found while parsing a config (Req 15.5). */
export interface RulesConfigError {
  /** Dotted location of the offending content within the document. */
  readonly location: string;
  /** Human-readable description identifying the malformed content. */
  readonly message: string;
}

/** The outcome of {@link parseRulesConfig}. */
export interface RulesConfigParseResult {
  /**
   * The config to use. When {@link malformed} is `true` this is the fail-safe
   * {@link ALL_SOFT_CONFIG} so every path resolves to `soft` (Req 15.5).
   */
  readonly config: RepositoryRulesConfig;
  /** All validation problems found; empty when the config is well-formed. */
  readonly errors: readonly RulesConfigError[];
  /** `true` when the config was malformed and the all-soft fallback is in use. */
  readonly malformed: boolean;
}

/** The three valid coordination modes, ordered least → most restrictive. */
const RISK_MODES = ["soft", "coordination-required", "hard"] as const;

/** Total order used for most-restrictive-wins resolution (Req 15.4). */
const RESTRICTIVENESS: Record<RiskLevel, number> = {
  soft: 0,
  "coordination-required": 1,
  hard: 2,
};

/**
 * The fail-safe config used whenever a Repository_Rules_Config is malformed
 * (Req 15.5): no rules and a `soft` default, so {@link resolveMode} returns
 * `soft` for every path and a broken file can never escalate coordination.
 */
export const ALL_SOFT_CONFIG: RepositoryRulesConfig = {
  version: 1,
  defaults: { mode: "soft" },
  rules: [],
};

/** Type guard: is `value` one of the three valid {@link RiskLevel} modes? */
export function isRiskLevel(value: unknown): value is RiskLevel {
  return (
    typeof value === "string" &&
    (RISK_MODES as readonly string[]).includes(value)
  );
}

/**
 * Return the most restrictive mode among `modes`, ordering
 * `hard > coordination-required > soft` (Req 15.4). An empty input resolves to
 * `soft`, which makes the caller's default-soft behavior fall out naturally.
 */
export function mostRestrictive(modes: Iterable<RiskLevel>): RiskLevel {
  let winner: RiskLevel = "soft";
  for (const mode of modes) {
    if (RESTRICTIVENESS[mode] > RESTRICTIVENESS[winner]) {
      winner = mode;
    }
  }
  return winner;
}

/**
 * Compile a single path *segment* glob (no `/`) to an anchored regex where `*`
 * matches any run of non-separator characters and `?` matches exactly one. All
 * other characters are matched literally (regex metacharacters escaped).
 */
function segmentToRegExp(segment: string): RegExp {
  let source = "^";
  for (const ch of segment) {
    if (ch === "*") {
      source += "[^/]*";
    } else if (ch === "?") {
      source += "[^/]";
    } else {
      source += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  source += "$";
  return new RegExp(source);
}

/**
 * Match remaining glob segments against remaining path segments, treating a
 * `**` segment as a globstar that matches zero or more whole path segments.
 * Non-globstar segments match exactly one path segment via {@link segmentToRegExp}.
 */
function matchSegments(
  globSegments: readonly string[],
  pathSegments: readonly string[],
  gi: number,
  pi: number,
): boolean {
  let g = gi;
  let p = pi;
  while (g < globSegments.length) {
    const segment = globSegments[g];
    if (segment === undefined) {
      return false;
    }
    if (segment === "**") {
      // Globstar: try consuming 0..N remaining path segments.
      for (let k = p; k <= pathSegments.length; k++) {
        if (matchSegments(globSegments, pathSegments, g + 1, k)) {
          return true;
        }
      }
      return false;
    }
    const pathSegment = pathSegments[p];
    if (pathSegment === undefined) {
      return false;
    }
    if (!segmentToRegExp(segment).test(pathSegment)) {
      return false;
    }
    g++;
    p++;
  }
  return p === pathSegments.length;
}

/** Split a normalized path/glob into non-empty segments. */
function segments(value: string): string[] {
  return normalizePath(value)
    .split("/")
    .filter((segment) => segment.length > 0);
}

/**
 * Return `true` if repository-relative `path` matches `glob`. Both are
 * normalized (separators unified, `.`/empty segments dropped) before matching.
 * Supports `*` (within a segment), `?` (single char), and `**` (globstar across
 * segments, matching zero or more directories).
 */
export function globMatch(glob: string, path: string): boolean {
  return matchSegments(segments(glob), segments(path), 0, 0);
}

/**
 * Resolve the coordination mode for a repository-relative `path` against `cfg`
 * (design §6). The mode is the most restrictive among every matching glob plus
 * the config default, ordering `hard > coordination-required > soft`
 * (Req 15.4); a path matching no glob resolves to the default, which is `soft`
 * for a well-formed config and always `soft` for the fail-safe fallback
 * (Req 15.3, 15.5).
 */
export function resolveMode(path: string, cfg: RepositoryRulesConfig): RiskLevel {
  const matches = cfg.rules
    .filter((rule) => globMatch(rule.glob, path))
    .map((rule) => rule.mode);
  return mostRestrictive([...matches, cfg.defaults.mode]);
}

/** Narrow an `unknown` to a plain (non-array, non-null) object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a *deserialized* Repository_Rules_Config document (Req 15.1–15.5).
 *
 * Checks that the document is an object with a supported `version`, a valid
 * `defaults.mode` (defaulting to `soft` when omitted), and a `rules` array whose
 * every entry has a non-empty `glob` string and a valid `mode`. Any problem is
 * collected into {@link RulesConfigParseResult.errors} identifying the offending
 * content.
 *
 * Fail-safe (Req 15.5): if the document is malformed in **any** way, the
 * returned {@link RulesConfigParseResult.config} is {@link ALL_SOFT_CONFIG} so
 * every path resolves to `soft` until the file is corrected — a broken config
 * never silently escalates a path to `hard`/`coordination-required`.
 */
export function parseRulesConfig(raw: unknown): RulesConfigParseResult {
  const errors: RulesConfigError[] = [];

  if (!isPlainObject(raw)) {
    errors.push({
      location: "(root)",
      message: `Repository_Rules_Config must be a mapping, got ${describe(raw)}.`,
    });
    return { config: ALL_SOFT_CONFIG, errors, malformed: true };
  }

  // version: MVP supports version 1.
  if (!("version" in raw)) {
    errors.push({ location: "version", message: "Missing required 'version' field." });
  } else if (raw.version !== 1) {
    errors.push({
      location: "version",
      message: `Unsupported version ${describe(raw.version)}; expected 1.`,
    });
  }

  // defaults.mode: optional; defaults to soft when omitted.
  let defaultMode: RiskLevel = "soft";
  if ("defaults" in raw && raw.defaults !== undefined) {
    if (!isPlainObject(raw.defaults)) {
      errors.push({
        location: "defaults",
        message: `'defaults' must be a mapping, got ${describe(raw.defaults)}.`,
      });
    } else if ("mode" in raw.defaults && raw.defaults.mode !== undefined) {
      if (isRiskLevel(raw.defaults.mode)) {
        defaultMode = raw.defaults.mode;
      } else {
        errors.push({
          location: "defaults.mode",
          message: `Invalid mode ${describe(raw.defaults.mode)}; expected one of ${RISK_MODES.join(", ")}.`,
        });
      }
    }
  }

  // rules: optional array of { glob, mode }.
  const rules: RepositoryRuleEntry[] = [];
  if ("rules" in raw && raw.rules !== undefined) {
    if (!Array.isArray(raw.rules)) {
      errors.push({
        location: "rules",
        message: `'rules' must be a list, got ${describe(raw.rules)}.`,
      });
    } else {
      raw.rules.forEach((entry, index) => {
        const location = `rules[${index}]`;
        if (!isPlainObject(entry)) {
          errors.push({
            location,
            message: `Rule must be a mapping, got ${describe(entry)}.`,
          });
          return;
        }
        const { glob, mode } = entry;
        const validGlob = typeof glob === "string" && glob.trim().length > 0;
        if (!validGlob) {
          errors.push({
            location: `${location}.glob`,
            message: `Rule 'glob' must be a non-empty string, got ${describe(glob)}.`,
          });
        }
        if (!isRiskLevel(mode)) {
          errors.push({
            location: `${location}.mode`,
            message: `Invalid mode ${describe(mode)}; expected one of ${RISK_MODES.join(", ")}.`,
          });
        }
        if (validGlob && isRiskLevel(mode)) {
          rules.push({ glob, mode });
        }
      });
    }
  }

  if (errors.length > 0) {
    // Fail-safe: any malformed content ⇒ all-soft until corrected (Req 15.5).
    return { config: ALL_SOFT_CONFIG, errors, malformed: true };
  }

  return {
    config: { version: 1, defaults: { mode: defaultMode }, rules },
    errors,
    malformed: false,
  };
}

/** Compact, safe description of an arbitrary value for error messages. */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  const type = typeof value;
  if (type === "object") return "a mapping";
  if (type === "string") return JSON.stringify(value);
  return String(value);
}
