/**
 * Property 1 — Event_Revision monotonicity and total order.
 *
 * **Validates: Requirements 8.1, 1.6**
 *
 * The CoordinationHost stamps every accepted coordination event with a
 * monotonically increasing Event_Revision that is unique and strictly ordered
 * *within* a `Repository_Session` (Req 8.1; design §4.5), and on restart resumes
 * assigning revisions strictly greater than every previously assigned revision
 * for each session (Req 1.6).
 *
 * This single fast-check property (≥100 iterations) asserts, for any interleaved
 * sequence of accepted events across one or more sessions handled by
 * {@link RevisionCounter}:
 *   - within each session the assigned revisions are strictly increasing,
 *     unique, and totally ordered by assignment order (they are exactly
 *     `1, 2, …, k`);
 *   - the per-session sequence is independent of the interleaving with other
 *     sessions — different sessions never interfere;
 *   - after a simulated restart (a fresh counter resumed from each session's max
 *     persisted revision) the next revision for a session strictly exceeds every
 *     revision previously assigned for that session.
 */

import { assertProperty, fc, propertyTag } from "@cfls/test-utils";
import { describe, expect, it } from "vitest";

import type { SessionId } from "@cfls/protocol";

import { RevisionCounter } from "./revisions";
import { sessionKey } from "./session";

/** A base session tuple (repo/team/baseRevision) shared by the branch variants. */
const baseSessionArb = fc.record({
  repoId: fc.constantFrom(
    "github.com/acme/app",
    "gitlab.com/org/repo",
    "example.com/x/y",
  ),
  teamId: fc.constantFrom("team-1", "team-2", "team-3"),
  baseRevision: fc.option(fc.hexaString({ minLength: 4, maxLength: 8 }), {
    nil: null,
  }),
});

/**
 * Generate `n` distinct sessions (distinct `session_key`s via distinct branch
 * labels) together with an interleaved sequence of "accepted events", each
 * naming the index of the session it targets.
 */
const scenarioArb = fc.integer({ min: 1, max: 4 }).chain((numSessions) =>
  fc.record({
    base: baseSessionArb,
    numSessions: fc.constant(numSessions),
    events: fc.array(fc.integer({ min: 0, max: numSessions - 1 }), {
      minLength: 0,
      maxLength: 200,
    }),
  }),
);

describe(propertyTag(1, "Event_Revision monotonicity and total order"), () => {
  it("assigns strictly increasing, unique, per-session-independent revisions that survive restart", () => {
    assertProperty(
      fc.property(scenarioArb, ({ base, numSessions, events }) => {
        // Distinct sessions: identical base tuple, distinct branch => distinct key.
        const sessions: SessionId[] = Array.from(
          { length: numSessions },
          (_unused, i) => ({
            repoId: base.repoId,
            teamId: base.teamId,
            branch: `branch-${i}`,
            baseRevision: base.baseRevision,
          }),
        );

        // Sanity: the generated sessions really are distinct coordination scopes.
        const distinctKeys = new Set(sessions.map((s) => sessionKey(s)));
        expect(distinctKeys.size).toBe(numSessions);

        const counter = new RevisionCounter();
        const assignedPerSession = new Map<number, number[]>();
        for (let i = 0; i < numSessions; i += 1) {
          assignedPerSession.set(i, []);
        }

        // Assign a revision to each accepted event in arrival order.
        for (const index of events) {
          const revision = counter.next(sessions[index]!);
          assignedPerSession.get(index)!.push(revision);
        }

        for (let i = 0; i < numSessions; i += 1) {
          const assigned = assignedPerSession.get(i)!;

          // Strictly increasing + totally ordered by assignment order, unique,
          // and independent of interleaving: the sequence is exactly 1..k.
          const expected = assigned.map((_unused, k) => k + 1);
          expect(assigned).toEqual(expected);

          // Uniqueness within the session (no revision assigned twice).
          expect(new Set(assigned).size).toBe(assigned.length);

          // `highest` matches the last assigned revision (0 when none).
          const highest =
            assigned.length === 0 ? 0 : assigned[assigned.length - 1]!;
          expect(counter.highest(sessions[i]!)).toBe(highest);

          // Simulated restart: a fresh counter resumed from the max persisted
          // revision must hand out a revision strictly greater than every
          // revision previously assigned for that session (Req 1.6).
          const resumed = new RevisionCounter([[sessions[i]!, highest]]);
          const afterRestart = resumed.next(sessions[i]!);
          expect(afterRestart).toBe(highest + 1);
          for (const previous of assigned) {
            expect(afterRestart).toBeGreaterThan(previous);
          }
        }
      }),
    );
  });
});
