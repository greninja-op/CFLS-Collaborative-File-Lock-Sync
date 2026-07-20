/**
 * Unit tests for the shared conflict resolver (task 4.9; design §10.2).
 *
 * Covers Req 8.2 (earliest Event_Revision wins), 8.3 (timestamps never
 * consulted — resolution reads only `eventRevision`/`claimId`), 8.4 (losers
 * recorded as concurrent claims carrying the winning member + revision), and the
 * order-independence relied on by 12.4, 14.5, 18.1, 18.3.
 */

import { describe, expect, it } from "vitest";

import type { MemberRef } from "@cfls/protocol";

import {
  compareClaims,
  type PlannedFileCreationClaim,
  resolveByEarliestRevision,
  resolvePlannedFileCreationClaims,
  type RevisionClaim,
} from "./conflict";

const alice: MemberRef = { memberId: "alice", deviceId: "alice-dev-1" };
const bob: MemberRef = { memberId: "bob", deviceId: "bob-dev-1" };
const carol: MemberRef = { memberId: "carol", deviceId: "carol-dev-1" };

function claim(
  claimId: string,
  eventRevision: number,
  holder: MemberRef,
): RevisionClaim {
  return { claimId, eventRevision, holder };
}

describe("resolveByEarliestRevision — winner selection (Req 8.2)", () => {
  it("returns no winner for an empty claim set", () => {
    expect(resolveByEarliestRevision([])).toEqual({
      winner: undefined,
      resolved: [],
    });
  });

  it("a single claim wins uncontended with no conflict info", () => {
    const only = claim("c1", 5, alice);
    const { winner, resolved } = resolveByEarliestRevision([only]);
    expect(winner).toBe(only);
    expect(resolved).toEqual([{ claim: only, concurrent: false }]);
  });

  it("grants the earliest Event_Revision the win", () => {
    const first = claim("c-late-id", 10, alice);
    const second = claim("c-early-id", 20, bob);
    const { winner } = resolveByEarliestRevision([second, first]);
    expect(winner).toBe(first);
    expect(winner?.holder).toEqual(alice);
  });
});

describe("resolveByEarliestRevision — concurrent claims (Req 8.4)", () => {
  it("records every loser as concurrent with the winning member + revision", () => {
    const winning = claim("c1", 100, alice);
    const losing = claim("c2", 200, bob);
    const alsoLosing = claim("c3", 300, carol);

    const { winner, resolved } = resolveByEarliestRevision([
      winning,
      losing,
      alsoLosing,
    ]);

    expect(winner).toBe(winning);
    const winnerEntry = resolved.find((r) => r.claim.claimId === "c1");
    expect(winnerEntry).toEqual({ claim: winning, concurrent: false });

    for (const loser of [losing, alsoLosing]) {
      const entry = resolved.find((r) => r.claim.claimId === loser.claimId);
      expect(entry?.concurrent).toBe(true);
      expect(entry?.conflict).toEqual({
        winner: alice,
        winningEventRevision: 100,
      });
    }
  });

  it("is order-independent: any permutation yields the same winner (Req 12.4, 18.3)", () => {
    const a = claim("a", 30, alice);
    const b = claim("b", 10, bob);
    const c = claim("c", 20, carol);

    const permutations = [
      [a, b, c],
      [a, c, b],
      [b, a, c],
      [b, c, a],
      [c, a, b],
      [c, b, a],
    ];

    for (const perm of permutations) {
      const { winner } = resolveByEarliestRevision(perm);
      expect(winner?.claimId).toBe("b"); // revision 10 is earliest
      expect(winner?.holder).toEqual(bob);
    }
  });

  it("preserves input order in the resolved array", () => {
    const a = claim("a", 30, alice);
    const b = claim("b", 10, bob);
    const { resolved } = resolveByEarliestRevision([a, b]);
    expect(resolved.map((r) => r.claim.claimId)).toEqual(["a", "b"]);
  });
});

describe("resolveByEarliestRevision — determinism (Req 8.3)", () => {
  it("breaks ties on the stable claimId, never a timestamp", () => {
    // Equal revisions (degenerate: the per-session counter never emits these,
    // but the resolver must still be total and deterministic).
    const later = claim("z", 42, alice);
    const earlier = claim("a", 42, bob);
    const { winner } = resolveByEarliestRevision([later, earlier]);
    expect(winner?.claimId).toBe("a");
  });

  it("compareClaims orders by revision then claimId", () => {
    expect(
      compareClaims(claim("x", 1, alice), claim("y", 2, bob)),
    ).toBeLessThan(0);
    expect(
      compareClaims(claim("y", 2, bob), claim("x", 1, alice)),
    ).toBeGreaterThan(0);
    expect(
      compareClaims(claim("a", 5, alice), claim("b", 5, bob)),
    ).toBeLessThan(0);
    expect(compareClaims(claim("a", 5, alice), claim("a", 5, alice))).toBe(0);
  });
});

describe("resolvePlannedFileCreationClaims (Req 18.1, 18.3)", () => {
  function pfc(
    claimId: string,
    eventRevision: number,
    holder: MemberRef,
  ): PlannedFileCreationClaim {
    return {
      claimId,
      eventRevision,
      holder,
      path: "src/new.ts",
      branch: "main",
    };
  }

  it("attributes the creation to the earliest declaration and marks the rest concurrent", () => {
    const first = pfc("pfc-1", 7, alice);
    const second = pfc("pfc-2", 9, bob);

    // Declared out of arrival order to prove order-independence.
    const { winner, resolved } = resolvePlannedFileCreationClaims([
      second,
      first,
    ]);

    expect(winner).toBe(first);
    const loser = resolved.find((r) => r.claim.claimId === "pfc-2");
    expect(loser?.concurrent).toBe(true);
    expect(loser?.conflict).toEqual({ winner: alice, winningEventRevision: 7 });
  });
});
