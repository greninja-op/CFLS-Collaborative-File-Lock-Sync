/**
 * Property 3 — Idempotency of duplicate Event_IDs.
 *
 * **Validates: Requirements 7.4**
 *
 * The CoordinationHost applies an event *at most once* per `Event_ID`: a duplicate
 * `eventId` is applied at most once and the host returns the previously assigned
 * Event_Revision (Req 7.4; design §4.4). This single fast-check property (≥100
 * iterations) asserts, for any interleaving of duplicate resubmissions of one
 * event with other genuinely-new accepted events through {@link IngestGate}:
 *
 *   - the target event's `Applier` runs **exactly once**, no matter how many
 *     additional times its `Event_ID` is submitted ("applies it at most once");
 *   - every resubmission returns `accepted: true` with `eventRevision` and
 *     `duplicateOf` equal to the revision originally assigned on first
 *     application ("returns the originally assigned Event_Revision each time"),
 *     even when the retransmission carries a would-be-stale replay counter/nonce
 *     (idempotency is resolved purely by `Event_ID`, before replay);
 *   - authoritative state contributed by the target event is unchanged by any
 *     duplicate submission ("leaves authoritative state unchanged after the
 *     first application"): the modeled applied-event log gains exactly one entry
 *     for the target `Event_ID` and a duplicate never mutates the log; and
 *   - duplicates consume no Event_Revision — the monotonic counter advances only
 *     for the genuinely-new events.
 */

import { assertProperty, fc, propertyTag } from "@cfls/test-utils";
import { describe, expect, it } from "vitest";

import {
  buildEnvelope,
  type SessionId,
  type SignedEvent,
} from "@cfls/protocol";

import { IngestGate } from "./ingest";
import { RevisionCounter } from "./revisions";

/** A distinct coordination session (distinct `session_key`). */
const sessionArb: fc.Arbitrary<SessionId> = fc.record({
  repoId: fc.constantFrom(
    "github.com/acme/app",
    "gitlab.com/org/repo",
    "example.com/x/y",
  ),
  teamId: fc.constantFrom("team-1", "team-2"),
  branch: fc.constantFrom("main", "dev", "feature/x"),
  baseRevision: fc.option(fc.hexaString({ minLength: 4, maxLength: 8 }), {
    nil: null,
  }),
});

/**
 * A sequence of operations against the gate, encoded as integers:
 *   0 = submit a *new* distinct event (advances the replay counter),
 *   1 = resubmit the target event verbatim (same counter + nonce),
 *   2 = resubmit the target event with a would-be-stale replay counter/nonce
 *       (proves the duplicate is caught by Event_ID before any replay check).
 */
const scenarioArb = fc.record({
  session: sessionArb,
  deviceId: fc.constantFrom("dev-A", "dev-B"),
  ops: fc.array(fc.integer({ min: 0, max: 2 }), {
    minLength: 1,
    maxLength: 40,
  }),
});

/** Build a well-formed lock.acquire SignedEvent (signature not verified by the gate). */
function makeEvent(
  session: SessionId,
  deviceId: string,
  eventId: string,
  counter: number,
  nonce: string,
): SignedEvent {
  const envelope = buildEnvelope({
    type: "lock.acquire",
    eventId,
    session,
    deviceId,
    replay: { counter, nonce },
    sentAt: "2024-01-01T00:00:00.000Z",
    payload: { scope: "src/index.ts", scopeKind: "file", mode: "soft" },
  });
  return { envelope, signature: "sig-placeholder" };
}

describe(propertyTag(3, "Idempotency of duplicate Event_IDs"), () => {
  it("applies a duplicate Event_ID at most once, returns the original revision, and leaves state unchanged", () => {
    assertProperty(
      fc.property(scenarioArb, (raw) => {
        // Guarantee at least one duplicate resubmission so the property is never vacuous.
        const ops = raw.ops.some((op) => op !== 0) ? raw.ops : [...raw.ops, 1];
        const { session, deviceId } = raw;

        const TARGET_ID = "evt-target";
        const TARGET_COUNTER = 1;
        const TARGET_NONCE = "nonce-target";

        const revisions = new RevisionCounter();
        const gate = new IngestGate({ revisions });

        // Authoritative state model: the log of (eventId, revision) the applier
        // has committed. The applier runs at most once per accepted event.
        const appliedLog: Array<[string, number]> = [];
        let targetApplyCount = 0;
        const apply = (envelope: { eventId: string }, rev: number): void => {
          appliedLog.push([envelope.eventId, rev]);
          if (envelope.eventId === TARGET_ID) targetApplyCount += 1;
        };

        // First application of the target event assigns its authoritative revision.
        const first = gate.ingest(
          makeEvent(session, deviceId, TARGET_ID, TARGET_COUNTER, TARGET_NONCE),
          apply,
        );
        expect(first.accepted).toBe(true);
        expect(first.duplicateOf).toBeUndefined();
        const originalRevision = first.eventRevision!;
        expect(originalRevision).toBe(1);
        expect(targetApplyCount).toBe(1);
        expect(appliedLog).toEqual([[TARGET_ID, originalRevision]]);

        let nextCounter = TARGET_COUNTER + 1; // new events must advance the counter
        let newIndex = 0;
        let bogusNonce = 0;

        for (const op of ops) {
          if (op === 0) {
            // A genuinely new, accepted event: distinct id, advancing counter/nonce.
            const id = `evt-new-${newIndex}`;
            const counter = nextCounter;
            const result = gate.ingest(
              makeEvent(
                session,
                deviceId,
                id,
                counter,
                `nonce-new-${newIndex}`,
              ),
              apply,
            );
            expect(result.accepted).toBe(true);
            expect(result.duplicateOf).toBeUndefined();
            expect(result.eventRevision).toBe(originalRevision + newIndex + 1);
            expect(appliedLog).toContainEqual([id, result.eventRevision!]);
            nextCounter += 1;
            newIndex += 1;
          } else {
            // A duplicate resubmission of the target Event_ID. Snapshot the
            // authoritative state to prove the duplicate does not mutate it.
            const before = appliedLog.map(
              (entry) => [...entry] as [string, number],
            );
            const beforeHighest = revisions.highest(session);
            const beforeApplyCount = targetApplyCount;

            const dup =
              op === 1
                ? // Verbatim retransmission (same counter + nonce).
                  makeEvent(
                    session,
                    deviceId,
                    TARGET_ID,
                    TARGET_COUNTER,
                    TARGET_NONCE,
                  )
                : // Would-be-stale replay values: idempotency by Event_ID must win
                  // before the replay guard is ever consulted.
                  makeEvent(
                    session,
                    deviceId,
                    TARGET_ID,
                    0,
                    `stale-${bogusNonce++}`,
                  );

            const result = gate.ingest(dup, apply);

            // Returns the originally assigned Event_Revision each time.
            expect(result.accepted).toBe(true);
            expect(result.eventRevision).toBe(originalRevision);
            expect(result.duplicateOf).toBe(originalRevision);

            // Applied at most once: the applier did not run again.
            expect(targetApplyCount).toBe(beforeApplyCount);

            // Authoritative state unchanged by the duplicate, and no revision consumed.
            expect(appliedLog).toEqual(before);
            expect(revisions.highest(session)).toBe(beforeHighest);
          }
        }

        // End-state invariants: the target was applied exactly once, still maps to
        // its original revision, and appears exactly once in the authoritative log.
        expect(targetApplyCount).toBe(1);
        expect(gate.appliedRevision(session, TARGET_ID)).toBe(originalRevision);
        expect(appliedLog.filter(([id]) => id === TARGET_ID)).toHaveLength(1);

        // Duplicates consumed no revisions: the counter advanced only for new events.
        expect(revisions.highest(session)).toBe(1 + newIndex);
      }),
    );
  });
});
