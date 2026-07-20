/**
 * Pure coordination-presence presentation helpers.
 *
 * The VS Code adapter owns every `vscode` API call. This module only decides
 * which coordination metadata is worth showing and turns it into safe,
 * human-readable strings. Keeping that boundary pure lets hover cards,
 * decorations, status-bar tooltips, and Explorer badges share exactly the
 * same self-exclusion and risk rules.
 */

import { normalizePath } from "@cfls/core-state";
import type { RiskLevel } from "@cfls/protocol";

import type { CoordinationViewModel, PathView } from "./view-model";

/** The information the adapter needs to render an active-editor annotation. */
export interface PresenceDecoration {
  message: string;
  riskLevel: RiskLevel;
}

/** The information the adapter needs to render an Explorer file decoration. */
export interface PresenceFileBadge {
  badge: string;
  tooltip: string;
  riskLevel: RiskLevel;
}

type SignalKind =
  | "hard-lock"
  | "coordination-required-lock"
  | "soft-lock"
  | "presence"
  | "intent"
  | "dependency";

interface CoordinationSignal {
  memberId: string;
  kind: SignalKind;
}

const SECRET_LIKE_MEMBER =
  /(?:^|[\s:._=-])(api[-_ ]?key|authorization|password|private[-_ ]?key|secret|token)(?:$|[\s:._=-])/i;
const TOKEN_VALUE =
  /^(?:sk|pk|rk|ghp)[_-][A-Za-z0-9_-]{12,}$|^github_pat_[A-Za-z0-9_]{12,}$|^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MARKDOWN_PUNCTUATION = new Set([
  "`",
  "*",
  "_",
  "{",
  "}",
  "[",
  "]",
  "<",
  ">",
  "(",
  ")",
  "#",
  "+",
  "-",
  ".",
  "!",
  "|",
]);

/**
 * Return the PathView for a repository-relative path. Normalizing here keeps
 * the UI resilient to equivalent `./src/file.ts` and `src\\file.ts` spellings.
 */
function findPathView(
  vm: CoordinationViewModel,
  path: string,
): PathView | undefined {
  const normalized = normalizePath(path);
  return vm.paths.find((view) => normalizePath(view.path) === normalized);
}

/** Collapse unsafe control characters and cap a UI label to a readable length. */
function plainText(value: string, fallback: string): string {
  const withoutControlCharacters = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f ? " " : character;
  }).join("");
  const compact = withoutControlCharacters
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return compact.length > 0 ? compact : fallback;
}

/**
 * Member ids normally contain display names. Do not surface something that
 * resembles a credential even if malformed upstream data puts it in that field.
 */
function displayMember(memberId: string): string {
  const member = plainText(memberId, "a teammate");
  return SECRET_LIKE_MEMBER.test(member) || TOKEN_VALUE.test(member)
    ? "a teammate"
    : member;
}

/** Escape ordinary text before interpolation into a VS Code MarkdownString. */
function markdownText(value: string): string {
  return Array.from(plainText(value, "a teammate"), (character) =>
    character === "\\" || MARKDOWN_PUNCTUATION.has(character)
      ? `\\${character}`
      : character,
  ).join("");
}

/** Render a path as safe, short inline Markdown code. */
function markdownPath(path: string): string {
  const safePath = plainText(path, "unknown path")
    .replace(/`/g, "'")
    .slice(0, 180);
  return `\`${safePath}\``;
}

/**
 * Collect every contributor attributed to a path, removing the local member
 * and duplicate role/member pairs. A dependency contributor is still useful
 * coordination metadata: it means a teammate's active work affects this path
 * indirectly, even though it is not a direct file lock.
 */
function signalsFor(
  view: PathView,
  selfMemberId: string,
): CoordinationSignal[] {
  const byKind: readonly [readonly string[], SignalKind][] = [
    [view.hardLockMembers, "hard-lock"],
    [view.coordinationRequiredMembers, "coordination-required-lock"],
    [view.softLockMembers, "soft-lock"],
    [view.presenceMembers, "presence"],
    [view.intentMembers, "intent"],
    [view.dependencyRiskMembers, "dependency"],
  ];
  const seen = new Set<string>();
  const signals: CoordinationSignal[] = [];

  for (const [members, kind] of byKind) {
    for (const memberId of members) {
      if (memberId === selfMemberId) {
        continue;
      }
      const key = `${kind}\u0000${memberId}`;
      if (!seen.has(key)) {
        seen.add(key);
        signals.push({ memberId, kind });
      }
    }
  }

  return signals;
}

function longSignal(signal: CoordinationSignal, markdown: boolean): string {
  const member = displayMember(signal.memberId);
  const name = markdown ? markdownText(member) : member;

  switch (signal.kind) {
    case "hard-lock":
      return `${name} holds a hard lock`;
    case "coordination-required-lock":
      return `${name} requires coordination`;
    case "soft-lock":
      return `${name} holds a soft lock`;
    case "presence":
      return `${name} is editing this file`;
    case "intent":
      return `${name} plans to change it`;
    case "dependency":
      return `${name} has related dependency work`;
  }
}

function shortSignal(signal: CoordinationSignal): string {
  const member = displayMember(signal.memberId);
  switch (signal.kind) {
    case "hard-lock":
      return `${member} hard lock`;
    case "coordination-required-lock":
      return `${member} coordination required`;
    case "soft-lock":
      return `${member} lock`;
    case "presence":
      return `${member} editing`;
    case "intent":
      return `${member} plans change`;
    case "dependency":
      return `${member} dependency risk`;
  }
}

function hasLockSignal(signals: readonly CoordinationSignal[]): boolean {
  return signals.some(
    (signal) =>
      signal.kind === "hard-lock" ||
      signal.kind === "coordination-required-lock" ||
      signal.kind === "soft-lock",
  );
}

function extraSignalSuffix(signals: readonly CoordinationSignal[]): string {
  return signals.length > 1 ? ` +${signals.length - 1}` : "";
}

/**
 * Build the Markdown body for a file hover, or `null` when no other member has
 * coordination metadata for that path.
 */
export function buildHoverMarkdown(
  vm: CoordinationViewModel,
  path: string,
  selfMemberId: string,
): string | null {
  const view = findPathView(vm, path);
  if (view === undefined) {
    return null;
  }

  const signals = signalsFor(view, selfMemberId);
  if (signals.length === 0) {
    return null;
  }

  return [
    "**🔒 CFLS — coordination**",
    "",
    signals.map((signal) => longSignal(signal, true)).join(" · "),
    "",
    `Risk: **${view.riskLevel}**`,
  ].join("\n");
}

/**
 * Return the compact active-editor annotation for a path, or `null` when that
 * editor has no coordination signal from another member.
 */
export function decorateForPath(
  vm: CoordinationViewModel,
  path: string,
  selfMemberId: string,
): PresenceDecoration | null {
  const view = findPathView(vm, path);
  if (view === undefined) {
    return null;
  }

  const signals = signalsFor(view, selfMemberId);
  const first = signals[0];
  if (first === undefined) {
    return null;
  }

  return {
    message: `🔒 ${shortSignal(first)}${extraSignalSuffix(signals)}`,
    riskLevel: view.riskLevel,
  };
}

/**
 * Build a safe Markdown status-bar tooltip that names only other members and
 * the repository-relative paths they are coordinating around.
 */
export function buildStatusTooltip(
  vm: CoordinationViewModel,
  selfMemberId: string,
): string {
  const state = vm.offline
    ? "CFLS is offline — coordination data may be stale."
    : vm.stale
      ? "CFLS is reconnecting — coordination data may be stale."
      : "CFLS is online.";
  const lines: string[] = [];

  for (const view of vm.paths) {
    const signals = signalsFor(view, selfMemberId);
    if (signals.length === 0) {
      continue;
    }
    lines.push(
      `- ${markdownPath(view.path)} — ${signals
        .map((signal) => longSignal(signal, true))
        .join(" · ")} — Risk: **${view.riskLevel}**`,
    );
  }

  for (const planned of vm.plannedFileCreations) {
    if (planned.memberId === selfMemberId) {
      continue;
    }
    lines.push(
      `- ${markdownPath(planned.path)} — ${markdownText(
        displayMember(planned.memberId),
      )} plans to create this file`,
    );
  }

  if (lines.length === 0) {
    return `**CFLS coordination**\n\n${state}\n\nNo other members are currently active on tracked files.`;
  }

  return [
    "**CFLS coordination**",
    "",
    state,
    "",
    ...lines,
    "",
    "Run **CFLS: Show Coordination Status** for details.",
  ].join("\n");
}

/**
 * Build the plain-text detail used by the explicit status command. The status
 * bar uses Markdown, while VS Code's modal notification detail is plain text.
 */
export function buildCoordinationStatusDetail(
  vm: CoordinationViewModel,
  selfMemberId: string,
): string {
  const lines: string[] = [];

  for (const view of vm.paths) {
    const signals = signalsFor(view, selfMemberId);
    if (signals.length === 0) {
      continue;
    }
    lines.push(
      `• ${plainText(view.path, "unknown path")} [${view.riskLevel}] — ${signals
        .map((signal) => longSignal(signal, false))
        .join(" · ")}`,
    );
  }

  for (const planned of vm.plannedFileCreations) {
    if (planned.memberId === selfMemberId) {
      continue;
    }
    lines.push(
      `• ${plainText(planned.path, "unknown path")} — ${displayMember(
        planned.memberId,
      )} plans to create this file`,
    );
  }

  return lines.length > 0
    ? lines.join("\n")
    : "No other members are currently active on tracked files.";
}

/**
 * Return Explorer badge data for a path with another member's coordination
 * signal. Lock-bearing paths use a lock badge; otherwise use the member's
 * initial so the Explorer remains compact and scannable.
 */
export function fileBadgeForPath(
  vm: CoordinationViewModel,
  path: string,
  selfMemberId: string,
): PresenceFileBadge | null {
  const view = findPathView(vm, path);
  if (view === undefined) {
    return null;
  }

  // Explorer badges deliberately stay literal: they mean another member is
  // actively editing this file or holds a lock on it. Intent and indirect
  // dependency signals remain available in hover, editor, and status UI but
  // should not make a file look actively held in the Explorer.
  const signals = signalsFor(view, selfMemberId).filter(
    (signal) => signal.kind !== "intent" && signal.kind !== "dependency",
  );
  const first = signals[0];
  if (first === undefined) {
    return null;
  }

  const member = displayMember(first.memberId);
  const initial = Array.from(member)[0]?.toUpperCase() ?? "•";
  return {
    badge: hasLockSignal(signals) ? "🔒" : initial,
    tooltip: longSignal(first, false),
    riskLevel: view.riskLevel,
  };
}
