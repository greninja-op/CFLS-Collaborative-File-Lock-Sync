/**
 * Property 15 — Coalescing and deduplication preserve final per-path state.
 *
 * **Validates: Requirements 34.1, 34.2, 34.3**
 *
 * Before the CoordinationAgent transmits outbound Presence_Events and lock
 * changes to the CoordinationHost it smooths rapid bursts through the pure
 * {@link Coalescer} engine (task 4.22; design §8.5). For any burst of
 * presence/lock changes enqueued within one coalescing window, the transmitted
 * set MUST:
 *
 *   - contain **at most one event per coalescing key** — the tuple
 *     `(kind, Team_Member, normalized repository-relative path)` — collapsing a
 *     run of changes on the same path/member to a single event (Req 34.1);
 *   - carry, for each emitted key, the **final resulting state** of that key
 *     within the burst (the change with the highest local sequence), so the
 *     transmitted data reflects the member's latest activity (Req 34.3);
 *   - **discard identical duplicates** — repeated changes with the same key and
 *     the same state signature collapse to a single transmission, and re-sending
 *     a state that was already transmitted for a key emits nothing (Req 34.2).
 *
 * This single fast-check property (≥100 iterations) generates an arbitrary burst
 * of presence/lock changes drawn from a small pool of members, paths, and states
 * (so bursts and exact duplicates on the same key occur frequently), enqueues
 * them in order under a generous outbound rate bound (so a single window flushes
 * every key), and asserts the three invariants above against an independently
 * computed "final state per key" oracle. It further asserts that re-enqueueing
 * every final state in a subsequent window transmits nothing, confirming that
 * identical duplicates across the burst window are discarded.
 */

import { assertProperty, fc, propertyTag } from "@cfls/test-utils";
import { describe, expect, it } from "vitest";

import type { MemberRef } from "@cfls/protocol";

import { Coalescer, type CoalescableKind, type OutboundEvent } from "./coalesce";
import { normalizePathKey } from "./path";

/** Fixed platform behavior so key derivation is deterministic across machines. */
const SENSITIVITY = "case-sensitive" as const;

/** A small member pool so many generated changes share a coalescing key. */
const MEMBERS: readonly MemberRef[] = [
  { memberId: "u-1", deviceId: "dev-1" },
  { memberId: "u-2", deviceId: "dev-2" },
];

/** A small path pool so bursts on the same path are frequent. */
const PATHS = ["a.ts", "src/b.ts", "src/nested/c.ts", "d.ts"] as const;

/** A small state pool so exact-duplicate states on a key occur frequently. */
const STATES = ["started", "editing", "stopped", "acquired", "released"] as const;

const KINDS: readonly CoalescableKind[] = ["presence", "lock"];

/** One generated presence/lock change within the burst (seq assigned later). */
const changeArb = fc.record({
  kind: fc.constantFrom(...KINDS),
  memberIdx: fc.integer({ min: 0, max: MEMBERS.length - 1 }),
  path: fc.constantFrom(...PATHS),
  state: fc.constantFrom(...STATES),
});

/** A burst of changes enqueued within a single coalescing window. */
const burstArb = fc.array(changeArb, { minLength: 0, maxLength: 40 });

/** The coalescing key used by the engine: `(kind, member, normalized path)`. */
function keyOf(kind: CoalescableKind, member: MemberRef, path: string): string {
  return `${kind}\u0000${member.memberId}\u0000${normalizePathKey(path, SENSITIVITY)}`;
}

describe(
  propertyTag(15, "coalescing and deduplication preserve final per-path state"),
  () => {
    it("emits at most one event per path equal to its final state and discards identical duplicates", () => {
      assertProperty(
        fc.property(burstArb, (changes) => {
          // Materialize the burst as ordered outbound events (seq = position).
          const events: OutboundEvent<string>[] = changes.map((c, seq) => {
            const member = MEMBERS[c.memberIdx]!;
            return {
              seq,
              kind: c.kind,
              path: c.path,
              member,
              stateSignature: c.state,
              payload: c.state,
            };
          });

          // Oracle: the final resulting state per coalescing key is the change
          // with the highest seq (last enqueued) for that key.
          const finalState = new Map<string, string>();
          for (const e of events) {
            finalState.set(keyOf(e.kind, e.member, e.path), e.stateSignature);
          }

          // A generous rate bound so a single flush transmits every key
          // (Req 34.4 is exercised separately in the unit tests).
          const c = new Coalescer<string>({
            sensitivity: SENSITIVITY,
            maxEventsPerWindow: events.length + 1,
          });
          for (const e of events) {
            c.enqueue(e);
          }

          const out = c.flush();

          // Req 34.1: at most one event per coalescing key.
          const outKeys = out.map((e) => keyOf(e.kind, e.member, e.path));
          expect(new Set(outKeys).size).toBe(outKeys.length);

          // Req 34.1 + 34.3: exactly the keys seen in the burst are emitted, and
          // each carries that key's final resulting state.
          expect(new Set(outKeys)).toEqual(new Set(finalState.keys()));
          for (const e of out) {
            const key = keyOf(e.kind, e.member, e.path);
            expect(e.stateSignature).toBe(finalState.get(key));
            // Payload travels verbatim with the winning state.
            expect(e.payload).toBe(finalState.get(key));
          }

          // Req 34.2: re-enqueueing every final state in a later window transmits
          // nothing — identical duplicates of the last-sent state are discarded.
          let seq = events.length;
          for (const [key, state] of finalState) {
            // Reconstruct a change matching this key's final state.
            const original = out.find(
              (e) => keyOf(e.kind, e.member, e.path) === key,
            )!;
            c.enqueue({
              seq: seq++,
              kind: original.kind,
              path: original.path,
              member: original.member,
              stateSignature: state,
              payload: state,
            });
          }
          expect(c.flush()).toHaveLength(0);
        }),
      );
    });
  },
);
