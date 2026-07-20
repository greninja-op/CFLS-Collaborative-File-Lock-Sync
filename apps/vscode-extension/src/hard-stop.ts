/**
 * Cooperative hard-stop enforcement (task 11.4; Req 3.5, 14.1, 14.2, 14.3, 14.4;
 * design §10.4, §10.5).
 *
 * {@link decideEdit} is a **pure function** that decides whether a cooperating
 * edit may proceed:
 *
 *   - Online + hard-mode path + a valid winning lock held by **another** member
 *     → the edit is rejected and the holder is reported (Req 14.1). Enforcement
 *     is cooperative (this decision), never OS-level (Req 14.2).
 *   - Offline → the edit is **not** blocked, but the decision reports
 *     "Offline — manual coordination required" for hard-mode paths and never
 *     claims safety (Req 14.4, 33). We cannot verify a winning lock while offline.
 *   - Otherwise → the edit is allowed.
 *
 * {@link enforceHardStop} adapts a rendered {@link CoordinationViewModel} + the
 * team's {@link RepositoryRulesConfig} into a {@link decideEdit} call, resolving
 * the path's mode from the rules even when no lock is currently held.
 */

import {
  normalizePath,
  resolveMode,
  type RepositoryRulesConfig,
} from "@cfls/core-state";
import type { RiskLevel } from "@cfls/protocol";

import { findPathView, type CoordinationViewModel } from "./view-model";

/** The outcome of a cooperating hard-stop decision. */
export type EditDecision =
  | { allowed: true; reason: "no-restriction" }
  | {
      allowed: false;
      reason: "hard-locked";
      holderMemberId: string;
      message: string;
    }
  | { allowed: true; reason: "offline-manual-coordination"; message: string };

/** The message reported for a hard-mode path while offline (Req 14.4). */
export const OFFLINE_MANUAL_COORDINATION_MESSAGE =
  "Offline — manual coordination required";

/** Inputs to the pure {@link decideEdit} function. */
export interface EditContext {
  /** The repository-relative path being edited. */
  path: string;
  /** The editing member's own id (used to ignore self-held locks). */
  selfMemberId: string;
  /** Whether the local agent is currently in Offline_State. */
  offline: boolean;
  /** The path's resolved Risk_Level mode from the Repository_Rules_Config. */
  mode: RiskLevel;
  /** The winning hard-lock holder's member id, when known from authoritative state. */
  hardLockHolderMemberId?: string | null;
}

/**
 * Decide whether a cooperating edit may proceed (Req 3.5, 14). Pure and
 * deterministic; see the module header for the full rule set.
 */
export function decideEdit(context: EditContext): EditDecision {
  const holder =
    context.hardLockHolderMemberId != null &&
    context.hardLockHolderMemberId !== context.selfMemberId
      ? context.hardLockHolderMemberId
      : null;

  // Offline: never claim hard-lock safety; report manual coordination for hard
  // paths (Req 14.4). The edit is not blocked (Req 3.5 caveat).
  if (context.offline) {
    if (context.mode === "hard") {
      return {
        allowed: true,
        reason: "offline-manual-coordination",
        message: OFFLINE_MANUAL_COORDINATION_MESSAGE,
      };
    }
    return { allowed: true, reason: "no-restriction" };
  }

  // Online: reject an edit to a hard-mode path with a winning lock held by
  // another member, reporting the holder (Req 14.1).
  if (context.mode === "hard" && holder !== null) {
    return {
      allowed: false,
      reason: "hard-locked",
      holderMemberId: holder,
      message:
        `Cannot edit '${context.path}': it is hard-locked by '${holder}'. ` +
        `Coordinate with the lock holder before editing.`,
    };
  }

  return { allowed: true, reason: "no-restriction" };
}

/**
 * Enforce hard-stop for an edit using the rendered coordination view model and
 * the team's rules config (task 11.4).
 *
 * The path's effective mode prefers the authoritative Risk_Level the agent
 * already resolved for the path in the Risk_Map (the view model); when the path
 * is absent from the view model it falls back to resolving the mode from the
 * team's {@link RepositoryRulesConfig} (defaulting to soft). Any winning
 * hard-lock holder is located in the view model (own activity is already
 * excluded from the Risk_Map, Req 31.5), then the decision is delegated to
 * {@link decideEdit}.
 */
export function enforceHardStop(
  vm: CoordinationViewModel,
  rules: RepositoryRulesConfig,
  path: string,
  selfMemberId: string,
): EditDecision {
  const normalized = normalizePath(path);
  const view = findPathView(vm, normalized) ?? findPathView(vm, path);
  const mode: RiskLevel = view?.riskLevel ?? resolveMode(normalized, rules);
  const hardLockHolderMemberId =
    view?.hardLockMembers.find((m) => m !== selfMemberId) ?? null;

  return decideEdit({
    path: normalized,
    selfMemberId,
    offline: vm.offline,
    mode,
    hardLockHolderMemberId,
  });
}
