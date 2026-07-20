/**
 * CoordinationAgent configuration: Repository_Session resolution (with the
 * manual-config fallback) and Repository_Rules_Config loading/validation
 * (task 9.6; Req 10.6, 15.1–15.5; design §9.4, §6).
 *
 * The agent derives its `Repository_Session` from git metadata where available
 * and otherwise from a manual `.coordination/session.yaml`/`.json` file
 * (Req 10.6). The team's committed `Repository_Rules_Config` is loaded from
 * `.coordination/rules.yaml`/`.json`; a malformed config falls back to all-soft
 * and NEVER silently escalates a path (Req 15.5). This module owns the file I/O
 * and JSON deserialization; the pure precedence logic lives in `@cfls/core-state`.
 */

import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  ALL_SOFT_CONFIG,
  deriveRepoId,
  parseRulesConfig,
  type RepositoryRulesConfig,
  type RulesConfigError,
} from "@cfls/core-state";
import type { SessionId } from "@cfls/protocol";

/** A manual session document (`.coordination/session.yaml`/`.json`) (Req 10.6). */
export interface ManualSessionConfig {
  repoId: string;
  teamId: string;
  branch: string;
  baseRevision?: string | null;
}

/** Inputs for {@link resolveSession}. */
export interface ResolveSessionInput {
  /** The team the session belongs to (always required). */
  teamId: string;
  /** Git remote URL, if discoverable, used to derive the canonical repoId. */
  remoteUrl?: string;
  /** Current branch (Branch_Context), if discoverable. */
  branch?: string;
  /** Base_Revision commit hash, if discoverable. */
  baseRevision?: string | null;
  /** Repository root, used to locate the manual `.coordination/session.*` file. */
  repoRoot?: string;
}

/** The resolved session plus whether it came from the manual fallback (Req 10.6). */
export interface ResolvedSession {
  session: SessionId;
  manualConfig: boolean;
}

/** The resolved rules config plus any validation problems (Req 15.5). */
export interface LoadedRules {
  config: RepositoryRulesConfig;
  errors: readonly RulesConfigError[];
  malformed: boolean;
  /** Whether a rules file was found at all (absent ⇒ all-soft, not malformed). */
  found: boolean;
}

/** Read and JSON-parse the first existing candidate file, or `null`. */
function readFirstJson(candidates: string[]): unknown | null {
  for (const path of candidates) {
    if (!existsSync(path)) {
      continue;
    }
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      // A present-but-unparseable file is reported by the caller as malformed
      // (rules) or ignored (session); return a sentinel object to signal "found".
      return { __unparseable: true };
    }
  }
  return null;
}

/**
 * Resolve the Repository_Session (Req 10.1, 10.6). When a git `remoteUrl` and
 * `branch` are available the canonical `repoId` is derived from the remote
 * (transport-independent) and `manualConfig` is `false`. Otherwise the manual
 * `.coordination/session.{json}` fallback is consulted; if it too is absent an
 * error is thrown, since the agent cannot coordinate without a session identity.
 */
export function resolveSession(input: ResolveSessionInput): ResolvedSession {
  if (input.remoteUrl !== undefined && input.branch !== undefined) {
    return {
      session: {
        repoId: deriveRepoId(input.remoteUrl),
        teamId: input.teamId,
        branch: input.branch,
        baseRevision: input.baseRevision ?? null,
      },
      manualConfig: false,
    };
  }

  const repoRoot = input.repoRoot ?? process.cwd();
  const manual = readFirstJson([
    join(repoRoot, ".coordination", "session.json"),
  ]);
  if (
    manual !== null &&
    typeof manual === "object" &&
    !("__unparseable" in (manual as Record<string, unknown>))
  ) {
    const m = manual as Partial<ManualSessionConfig>;
    if (
      typeof m.repoId === "string" &&
      typeof m.teamId === "string" &&
      typeof m.branch === "string"
    ) {
      return {
        session: {
          repoId: m.repoId,
          teamId: m.teamId,
          branch: m.branch,
          baseRevision: m.baseRevision ?? null,
        },
        manualConfig: true,
      };
    }
  }

  throw new Error(
    "Cannot resolve a Repository_Session: no git metadata and no valid " +
      ".coordination/session.json manual fallback (Req 10.6).",
  );
}

/**
 * Load and validate the team's Repository_Rules_Config from
 * `.coordination/rules.json` under `repoRoot` (Req 15.1–15.5). A missing file
 * yields the all-soft default (not malformed); a present-but-invalid file yields
 * the all-soft fallback with `malformed: true` so a broken config can never
 * escalate a path to hard/coordination-required (Req 15.5).
 */
export function loadRulesConfig(repoRoot: string): LoadedRules {
  const raw = readFirstJson([join(repoRoot, ".coordination", "rules.json")]);
  if (raw === null) {
    return {
      config: ALL_SOFT_CONFIG,
      errors: [],
      malformed: false,
      found: false,
    };
  }
  if (
    typeof raw === "object" &&
    raw !== null &&
    "__unparseable" in (raw as Record<string, unknown>)
  ) {
    return {
      config: ALL_SOFT_CONFIG,
      errors: [
        { location: "<file>", message: "Rules file is not valid JSON." },
      ],
      malformed: true,
      found: true,
    };
  }
  const result = parseRulesConfig(raw);
  return {
    config: result.config,
    errors: result.errors,
    malformed: result.malformed,
    found: true,
  };
}
