/**
 * Property 4 — Replay rejection leaves state unchanged.
 *
 * **Validates: Requirements 7.5**
 *
 * For any device event stream, an event whose replay counter is less than or
 * equal to the highest counter already accepted for that device (or whose nonce
 * is reused) is rejected, and the replay record is identical to the record held
 * before the replayed event was received (design §4.4, Property 4).
 *
 * This test drives the real replay logic (`evaluateReplay` / `createReplayGuard`
 * from ./replay). It first builds up an accepted history from a random stream of
 * events, then injects an event that is provably a replay (a counter <= highest
 * accepted, or a reused nonce) and asserts (a) the event is rejected and (b) the
 * device's replay record — highest counter and used-nonce set — is byte-for-byte
 * identical before and after.
 */

import { assertProperty, fc, propertyTag } from "@cfls/test-utils";
import { describe, expect, it } from "vitest";

import { createReplayGuard, type ReplayRecord } from "./replay";

/** A single replay-relevant field of an event: its per-device counter and nonce. */
interface ReplayEvent {
  readonly counter: number;
  readonly nonce: string;
}

/** Snapshot a replay record into a plain, comparable shape for equality checks. */
function freeze(record: ReplayRecord | undefined): {
  highestCounter: number;
  nonces: string[];
} {
  return {
    highestCounter: record?.highestCounter ?? 0,
    nonces: [...(record?.usedNonces ?? [])].sort(),
  };
}

/**
 * Generate a strictly-increasing, fresh-nonce accepted history for one device so
 * we have a non-trivial record to attempt to replay against.
 */
const acceptedHistory = fc
  .array(
    fc.record({
      step: fc.integer({ min: 1, max: 20 }), // counter increment (keeps monotonicity)
      nonce: fc.string({ minLength: 1, maxLength: 12 }),
    }),
    { minLength: 1, maxLength: 12 },
  )
  .map((entries) => {
    // Turn increments into a strictly-increasing counter sequence with unique nonces.
    let counter = 0;
    const seenNonces = new Set<string>();
    const events: ReplayEvent[] = [];
    for (const [i, entry] of entries.entries()) {
      counter += entry.step;
      // Guarantee nonce uniqueness within the accepted history.
      let nonce = entry.nonce;
      while (seenNonces.has(nonce)) {
        nonce = `${nonce}#${i}`;
      }
      seenNonces.add(nonce);
      events.push({ counter, nonce });
    }
    return events;
  });

describe(propertyTag(4, "Replay rejection leaves state unchanged"), () => {
  it("rejects a stale-counter or reused-nonce event and leaves the replay record unchanged", () => {
    assertProperty(
      fc.property(
        acceptedHistory,
        // How the replayed event is constructed:
        //  - "stale-counter": counter <= highest accepted (offset chosen below)
        //  - "reused-nonce":  a fresh, advancing counter but a nonce already used
        fc.constantFrom<"stale-counter" | "reused-nonce">(
          "stale-counter",
          "reused-nonce",
        ),
        fc.nat(), // used to pick the offending counter / nonce deterministically
        fc.string({ minLength: 1, maxLength: 12 }), // candidate fresh nonce
        (history, kind, pick, freshNonce) => {
          const deviceId = "device-under-test";
          const guard = createReplayGuard();

          // Build up the accepted history; every event here must be accepted.
          for (const event of history) {
            const decision = guard.acceptReplay(
              deviceId,
              event.counter,
              event.nonce,
            );
            expect(decision.accepted).toBe(true);
          }

          const highest = history[history.length - 1]!.counter;
          const usedNonces = history.map((e) => e.nonce);

          // Snapshot state immediately before the replayed event.
          const before = freeze(guard.recordFor(deviceId));

          // Construct an event that MUST be treated as a replay.
          let replay: ReplayEvent;
          if (kind === "stale-counter") {
            // A counter in [0, highest] is <= highest accepted → rejected.
            const staleCounter = pick % (highest + 1);
            // Use a nonce not previously used so counter is the sole reason for rejection.
            let nonce = `${freshNonce}~stale`;
            while (usedNonces.includes(nonce)) nonce = `${nonce}~`;
            replay = { counter: staleCounter, nonce };
          } else {
            // A strictly-advancing counter but a nonce already consumed → rejected.
            const reusedNonce = usedNonces[pick % usedNonces.length]!;
            replay = { counter: highest + 1 + (pick % 5), nonce: reusedNonce };
          }

          const decision = guard.acceptReplay(
            deviceId,
            replay.counter,
            replay.nonce,
          );

          // (a) The replayed event is rejected.
          expect(decision.accepted).toBe(false);

          // (b) The replay record is identical to the pre-replay snapshot.
          const after = freeze(guard.recordFor(deviceId));
          expect(after).toEqual(before);
        },
      ),
    );
  });
});
