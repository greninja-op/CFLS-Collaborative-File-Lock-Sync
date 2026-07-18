/**
 * Conflict resolution by earliest Event_Revision (task 4.9; design §10.2).
 *
 * Requirements 8.2, 8.3, 8.4, 12.4, 14.5, 18.1, 18.3.
 *
 * This module is the single, shared authority for resolving *competing claims*
 * over the same coordination target — a lock on a `(scope, branch)` group
 * (Req 12.4, 14.5) or a Planned_File_Creation on a `(path, branch)` group
 * (Req 18.1, 18.3). Both consumers funnel through {@link resolveByEarliestRevision}
 * so they converge on exactly one winner using the same rule.
 *
 * The rule (Req 8.2): **the winner is the claim with the earliest assigned
 * Event_Revision.** Because the host assigns a strict, unique per-session total
 * order of Event_Revisions (task 4.4), this is deterministic and, critically,
 * **independent of the order in which claims are recorded** — a claim that
 * arrives later but carries an earlier revision still wins. Raw client
 * timestamps are never consulted here (Req 8.3): resolution reads `eventRevision`
 * only. A stable `claimId` tiebreaker keeps the result total even in the
 * degenerate case of equal revisions (which the per-session counter never
 * produces, but which a pure resolver must still handle deterministically).
 *
 * Every non-winning claim is reported as a **concurrent claim** annotated with
 * the winning member identity and winning Event_Revision (Req 8.4, 12.4, 18.1)
 * so affected agents can name the holder they lost to.
 */

import type { MemberRef } from "@cfls/protocol";

/**
 * The minimum shape a competing claim must expose to be resolved. Locks and
 * Planned_File_Creation claims both satisfy this via their own fields.
 */
export interface RevisionClaim {
  /**
   * Stable, unique identifier for the claim within its contended group (e.g. a
   * `lockId` or a Planned_File_Creation claim id). Used only as a deterministic
   * tiebreaker when two claims report the same Event_Revision.
   */
  claimId: string;
  /** The authoritative Event_Revision assigned by the host (Req 8.1). */
  eventRevision: number;
  /** The Team_Member (and originating device) that made the claim. */
  holder: MemberRef;
}

/**
 * The winning member identity and Event_Revision reported to the holders of
 * losing (concurrent) claims (Req 8.4, 12.4, 18.1).
 */
export interface ConflictInfo {
  /** The Team_Member that holds the winning claim. */
  winner: MemberRef;
  /** The winning claim's Event_Revision. */
  winningEventRevision: number;
}

/** A claim after resolution, tagged with whether it won or is concurrent. */
export interface ResolvedClaim<C extends RevisionClaim> {
  /** The original claim. */
  claim: C;
  /** True for every claim that is not the winner (a losing/concurrent claim). */
  concurrent: boolean;
  /**
   * For concurrent claims, the winning member + revision to report (Req 8.4).
   * `undefined` on the winner itself.
   */
  conflict?: ConflictInfo;
}

/** The outcome of resolving a group of competing claims. */
export interface Resolution<C extends RevisionClaim> {
  /** The single winning claim, or `undefined` when there are no claims. */
  winner: C | undefined;
  /**
   * Every claim tagged with its concurrent flag and (for losers) the conflict
   * info. Input order is preserved so callers can map results back onto their
   * own storage without re-sorting.
   */
  resolved: ResolvedClaim<C>[];
}

/**
 * Compare two claims by the conflict-resolution ordering: earliest
 * Event_Revision wins; ties break on the stable `claimId`. Returns a negative
 * number when `a` should win over `b`, positive when `b` should win, and `0`
 * only when the two are the identical claim.
 *
 * Exported so consumers (e.g. winner promotion on lock release) can reuse the
 * exact same total order rather than re-deriving "earliest revision" logic.
 */
export function compareClaims(a: RevisionClaim, b: RevisionClaim): number {
  if (a.eventRevision !== b.eventRevision) {
    return a.eventRevision - b.eventRevision;
  }
  // Equal revisions: deterministic tiebreak on the stable claim id.
  if (a.claimId < b.claimId) {
    return -1;
  }
  if (a.claimId > b.claimId) {
    return 1;
  }
  return 0;
}

/**
 * Resolve a set of competing claims for the same contended target (Req 8.2).
 *
 * Selects the claim with the earliest assigned Event_Revision as the winner and
 * tags every other claim as concurrent, attaching the winning member identity
 * and Event_Revision (Req 8.4). The computation reads `eventRevision` (and the
 * `claimId` tiebreaker) only — never a timestamp (Req 8.3) — and does not depend
 * on the order of `claims`, so any permutation of the same inputs yields the
 * same winner (Req 12.4, 14.5, 18.3).
 *
 * @param claims the competing claims for one `(scope|path, branch)` group.
 * @returns the winner and each claim tagged with its concurrent status.
 */
export function resolveByEarliestRevision<C extends RevisionClaim>(
  claims: readonly C[],
): Resolution<C> {
  if (claims.length === 0) {
    return { winner: undefined, resolved: [] };
  }

  let winner = claims[0] as C;
  for (let i = 1; i < claims.length; i += 1) {
    const candidate = claims[i] as C;
    if (compareClaims(candidate, winner) < 0) {
      winner = candidate;
    }
  }

  const conflict: ConflictInfo = {
    winner: winner.holder,
    winningEventRevision: winner.eventRevision,
  };

  const resolved = claims.map((claim) => {
    const isWinner = claim.claimId === winner.claimId;
    return isWinner
      ? { claim, concurrent: false }
      : { claim, concurrent: true, conflict };
  });

  return { winner, resolved };
}

/**
 * A member's claim to create a not-yet-existing file (Planned_File_Creation)
 * under a Branch_Context, resolved for collision against other members' claims
 * on the same path/branch (Req 18.1, 18.3).
 */
export interface PlannedFileCreationClaim extends RevisionClaim {
  /** Repository-relative path the member plans to create (<=4096 chars). */
  path: string;
  /** Branch_Context under which the creation is planned. */
  branch: string;
}

/**
 * Resolve competing Planned_File_Creation claims for the same `(path, branch)`
 * group (Req 18.1, 18.3). This is the same earliest-Event_Revision rule used
 * for locks: the earliest-revision declaration is attributed the creation and
 * every later declaration is recorded as a concurrent claim carrying the winning
 * member + revision (Req 8.4). Callers group by normalized path and branch
 * before calling; the resolution itself is order-independent.
 *
 * This function deliberately covers *only* collision resolution (task 4.9). The
 * surrounding Declared_Intent lifecycle, create→modify reclassification, and
 * duplicate detection are layered on top by the intent registry (task 4.11).
 */
export function resolvePlannedFileCreationClaims(
  claims: readonly PlannedFileCreationClaim[],
): Resolution<PlannedFileCreationClaim> {
  return resolveByEarliestRevision(claims);
}
