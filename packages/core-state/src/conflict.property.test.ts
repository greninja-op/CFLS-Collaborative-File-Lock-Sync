/**
 * Property 2 — Conflict resolution is deterministic and order-independent.
 *
 * **Validates: Requirements 8.2, 8.3, 8.4, 12.4, 14.5, 18.1, 18.3**
 *
 * The shared conflict resolver ({@link resolveByEarliestRevision}, task 4.9;
 * design §10.2) is the single authority that picks one winner among competing
 * claims — Soft_Locks, Coordination_Required/Hard locks, or
 * Planned_File_Creations — contending for the same scope under the same
 * Branch_Context. Property 2 states that, for *any* such set of claims:
 *   - the winner is exactly the claim with the earliest assigned
 *     Event_Revision (ties broken deterministically by the stable `claimId`)
 *     (Req 8.2);
 *   - every other claim is recorded as a concurrent claim annotated with the
 *     winning member identity and winning Event_Revision (Req 8.4, 12.4, 18.1);
 *   - the outcome is identical for *all* arrival-order permutations of the same
 *     inputs (Req 12.4, 14.5, 18.3); and
 *   - the outcome depends only on Event_Revision, never on a raw client
 *     timestamp — even when timestamps directly contradict the revision order
 *     (Req 8.3).
 *
 * This single fast-check property (≥100 iterations) generates an arbitrary set
 * of distinctly-identified claims, each carrying an arbitrary Event_Revision and
 * an *anti-correlated* client timestamp (earliest revision ⇒ latest timestamp)
 * so that a timestamp-based resolver would disagree with the required outcome.
 * It then asserts the winner/concurrent tagging matches an independently
 * computed expectation, that resolving an arbitrary permutation of the same
 * claims yields the identical winner and concurrent set, and that replacing the
 * client timestamps with different values leaves the outcome unchanged.
 */

import { assertProperty, fc, propertyTag } from "@cfls/test-utils";
import { describe, expect, it } from "vitest";

import type { MemberRef } from "@cfls/protocol";

import {
  compareClaims,
  resolveByEarliestRevision,
  type RevisionClaim,
} from "./conflict";

/** A claim carrying a raw client timestamp the resolver must never consult. */
interface TimestampedClaim extends RevisionClaim {
  /** Raw client wall-clock reading — deliberately anti-correlated to revision. */
  clientTimestamp: number;
}

/** One generated competitor: an Event_Revision and the member behind it. */
const competitorArb = fc.record({
  eventRevision: fc.integer({ min: 0, max: 60 }),
  memberIdx: fc.integer({ min: 0, max: 5 }),
});

const scenarioArb = fc.record({
  competitors: fc.array(competitorArb, { minLength: 1, maxLength: 8 }),
  /**
   * A permutation seed per competitor: sorting the claims by this key yields an
   * arbitrary alternate arrival order that must not change the resolution.
   */
  orderKeys: fc.array(fc.integer({ min: 0, max: 1_000 }), {
    minLength: 8,
    maxLength: 8,
  }),
});

function member(idx: number): MemberRef {
  return { memberId: `mem-${idx}`, deviceId: `mem-${idx}-dev` };
}

/**
 * Independently compute the expected winner: the claim minimizing
 * (eventRevision, claimId), i.e. earliest revision with a stable id tiebreak.
 * This mirrors the resolver's total order without reusing its selection loop.
 */
function expectedWinner(claims: readonly TimestampedClaim[]): TimestampedClaim {
  return claims.reduce((best, c) => (compareClaims(c, best) < 0 ? c : best));
}

describe(
  propertyTag(2, "conflict resolution is deterministic and order-independent"),
  () => {
    it("selects the earliest-revision winner, tags the rest concurrent, and is order- and timestamp-independent", () => {
      assertProperty(
        fc.property(scenarioArb, ({ competitors, orderKeys }) => {
          // Build distinctly-identified claims. Client timestamps are
          // anti-correlated with revision (earliest revision => latest
          // timestamp) so a timestamp-based resolver would pick the opposite
          // winner from the required (revision-based) one (Req 8.3).
          const claims: TimestampedClaim[] = competitors.map((c, i) => ({
            claimId: `claim-${i}`,
            eventRevision: c.eventRevision,
            holder: member(c.memberIdx),
            clientTimestamp: 1_000_000 - c.eventRevision,
          }));

          const winner = expectedWinner(claims);
          const expectedConflict = {
            winner: winner.holder,
            winningEventRevision: winner.eventRevision,
          };

          // --- 1. Winner selection + concurrent tagging (Req 8.2, 8.4) -------
          const base = resolveByEarliestRevision(claims);
          expect(base.winner?.claimId).toBe(winner.claimId);

          // Input order preserved in the resolved array.
          expect(base.resolved.map((r) => r.claim.claimId)).toEqual(
            claims.map((c) => c.claimId),
          );

          for (const entry of base.resolved) {
            if (entry.claim.claimId === winner.claimId) {
              expect(entry.concurrent).toBe(false);
              expect(entry.conflict).toBeUndefined();
            } else {
              expect(entry.concurrent).toBe(true);
              expect(entry.conflict).toEqual(expectedConflict);
            }
          }

          // --- 2. Order-independence (Req 12.4, 14.5, 18.3) -----------------
          // Resolve an arbitrary permutation of the exact same claims.
          const permuted = claims
            .map((claim, i) => ({ claim, key: orderKeys[i] as number, i }))
            .sort((a, b) => (a.key === b.key ? a.i - b.i : a.key - b.key))
            .map((e) => e.claim);

          const permResult = resolveByEarliestRevision(permuted);
          expect(permResult.winner?.claimId).toBe(winner.claimId);

          const concurrentIds = (
            result: ReturnType<typeof resolveByEarliestRevision<TimestampedClaim>>,
          ) =>
            new Set(
              result.resolved
                .filter((r) => r.concurrent)
                .map((r) => r.claim.claimId),
            );
          expect(concurrentIds(permResult)).toEqual(concurrentIds(base));

          // --- 3. Timestamp-independence (Req 8.3) --------------------------
          // Same revisions, entirely different client timestamps: the outcome
          // must be unchanged because timestamps are never consulted.
          const reTimestamped = claims.map((c, i) => ({
            ...c,
            clientTimestamp: i * 37 + 5,
          }));
          const tsResult = resolveByEarliestRevision(reTimestamped);
          expect(tsResult.winner?.claimId).toBe(winner.claimId);
          expect(concurrentIds(tsResult)).toEqual(concurrentIds(base));
        }),
      );
    });
  },
);
