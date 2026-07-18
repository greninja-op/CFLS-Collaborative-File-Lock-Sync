/**
 * Coordination-required acknowledgement / override validation with audit
 * (Req 13.2–13.4; design §10.3).
 *
 * A coordination-required path forces an explicit acknowledgement or override
 * before an edit proceeds (Req 13.1). When a Team_Member or AI_Agent overrides
 * such a restriction they must supply an `Override_Reason`, which the
 * CoordinationHost records verbatim in an {@link import('@cfls/protocol').AuditRecord}
 * (Req 13.3). This module is the pure, dependency-free authority for that rule:
 *
 * - {@link validateOverride} accepts an override request and, when a non-blank
 *   reason is present, returns the {@link import('@cfls/protocol').AuditRecord}
 *   to persist (action `override`, no source content — Req 28.2).
 * - When the reason is absent or blank (whitespace-only), the override is
 *   rejected with `OVERRIDE_REASON_REQUIRED` and no audit record is produced
 *   (Req 13.4). Rejection is total: the caller must not treat the edit as
 *   permitted.
 *
 * Like the other core-state authorities it never consults a clock — the caller
 * assigns the authoritative `eventRevision` (task 4.4) and the `at` timestamp,
 * and the record captures them verbatim.
 */

import type { AuditRecord, MemberRef, SessionId } from "@cfls/protocol";

/** Error surfaced when a coordination-required override omits its reason (Req 13.4). */
export type OverrideError = "OVERRIDE_REASON_REQUIRED";

/** A request to override a coordination-required restriction (Req 13.2). */
export interface OverrideRequest {
  session: SessionId;
  /** The Team_Member (and originating device) performing the override. */
  member: MemberRef;
  /** Repository-relative path or Intent_Scope the override applies to. */
  scope: string;
  /** The Override_Reason recorded in the Audit_Record (Req 13.3, 13.4). */
  overrideReason: string;
  /** Authoritative Event_Revision assigned by the host. */
  eventRevision: number;
  /** ISO-8601 time the override was accepted (recorded verbatim). */
  at: string;
}

/** Result of {@link validateOverride}. */
export type OverrideResult =
  | { ok: true; audit: AuditRecord }
  | { ok: false; code: OverrideError };

/**
 * Validate a coordination-required override (Req 13.3, 13.4).
 *
 * When {@link OverrideRequest.overrideReason} is present and not blank, returns
 * an {@link AuditRecord} (action `override`) capturing the overriding member and
 * device, the affected scope, the reason, and the assigning Event_Revision —
 * with no source content (Req 13.3, 28.2). When the reason is missing or
 * whitespace-only, the override is rejected with `OVERRIDE_REASON_REQUIRED` and
 * no record is produced (Req 13.4).
 */
export function validateOverride(request: OverrideRequest): OverrideResult {
  if (request.overrideReason.trim().length === 0) {
    return { ok: false, code: "OVERRIDE_REASON_REQUIRED" };
  }

  const audit: AuditRecord = {
    member: request.member,
    action: "override",
    targetScope: request.scope,
    eventRevision: request.eventRevision,
    time: request.at,
    overrideReason: request.overrideReason,
  };

  return { ok: true, audit };
}
