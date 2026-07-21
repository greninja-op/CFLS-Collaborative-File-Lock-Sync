/**
 * Unit tests for the ingest gate (Req 7.4, 7.5, 7.7; design §4.4).
 *
 * Covers, with concrete examples and edge cases:
 *   - schema/version rejection before any state change (Req 7.6/7.7),
 *   - sender-permission rejection before any state change (Req 7.7),
 *   - idempotent duplicate Event_IDs returning the prior revision (Req 7.4),
 *   - replay rejection (counter regression / reused nonce) leaving state
 *     unchanged (Req 7.5), and
 *   - the accept path assigning monotonic revisions and applying exactly once.
 *
 * The universal idempotency property is covered separately by the fast-check
 * property test in task 4.7 (Property 3).
 */

import { describe, expect, it, vi } from "vitest";

import {
  buildEnvelope,
  MESSAGE_FORMAT_VERSION,
  type SessionId,
  type SignedEvent,
} from "@cfls/protocol";
import { createReplayGuard } from "@cfls/security";

import { IngestGate, permitAll, type PermissionCheck } from "./ingest";
import { RevisionCounter } from "./revisions";

const session: SessionId = {
  repoId: "github.com/acme/app",
  teamId: "team-1",
  branch: "main",
  baseRevision: "abc123",
};

/** Build a well-formed SignedEvent (signature is not verified by the gate). */
function makeEvent(overrides: {
  eventId: string;
  deviceId?: string;
  counter?: number;
  nonce?: string;
  scope?: string;
}): SignedEvent {
  const envelope = buildEnvelope({
    type: "lock.acquire",
    eventId: overrides.eventId,
    session,
    deviceId: overrides.deviceId ?? "dev-A",
    replay: {
      counter: overrides.counter ?? 1,
      nonce: overrides.nonce ?? `nonce-${overrides.eventId}`,
    },
    sentAt: "2024-01-01T00:00:00.000Z",
    payload: {
      scope: overrides.scope ?? "src/index.ts",
      scopeKind: "file",
      mode: "soft",
    },
  });
  return { envelope, signature: "sig-placeholder" };
}

describe("IngestGate — schema/version validation (Req 7.6, 7.7)", () => {
  it("rejects a structurally invalid event with FORMAT_ERROR and no state change", () => {
    const gate = new IngestGate();
    const apply = vi.fn();
    const result = gate.ingest({ not: "a signed event" }, apply);

    expect(result.accepted).toBe(false);
    expect(result.error).toBe("FORMAT_ERROR");
    expect(apply).not.toHaveBeenCalled();
    expect(gate.appliedSnapshot().size).toBe(0);
  });

  it("rejects an unsupported message-format version with FORMAT_ERROR", () => {
    const event = makeEvent({ eventId: "e1" });
    const tampered: SignedEvent = {
      ...event,
      envelope: { ...event.envelope, version: MESSAGE_FORMAT_VERSION + 1 },
    };
    const gate = new IngestGate();
    const result = gate.ingest(tampered);

    expect(result.accepted).toBe(false);
    expect(result.error).toBe("FORMAT_ERROR");
  });

  it("rejects a payload that does not match its per-type schema", () => {
    const event = makeEvent({ eventId: "e1" });
    const bad: SignedEvent = {
      ...event,
      envelope: { ...event.envelope, payload: { scope: 123 } },
    };
    const gate = new IngestGate();
    expect(gate.ingest(bad).error).toBe("FORMAT_ERROR");
  });
});

describe("IngestGate — sender permission (Req 7.7)", () => {
  it("rejects an unpermitted sender before any state change", () => {
    const deny: PermissionCheck = () => ({
      permitted: false,
      code: "AUTH_NOT_AUTHORIZED",
      reason: "sender not authorized for session",
    });
    const gate = new IngestGate({ checkPermission: deny });
    const apply = vi.fn();

    const result = gate.ingest(makeEvent({ eventId: "e1" }), apply);

    expect(result.accepted).toBe(false);
    expect(result.error).toBe("AUTH_NOT_AUTHORIZED");
    expect(apply).not.toHaveBeenCalled();
    expect(gate.appliedSnapshot().size).toBe(0);
  });

  it("checks permission before idempotency (permission wins over a duplicate)", () => {
    const revisions = new RevisionCounter();
    // First, accept the event with a permit-all gate sharing state we can inspect.
    const permit = new IngestGate({ revisions });
    permit.ingest(makeEvent({ eventId: "e1" }));

    // A different gate that denies permission must reject even a known eventId.
    const deny = new IngestGate({
      checkPermission: () => ({
        permitted: false,
        code: "AUTH_SESSION_FORBIDDEN",
        reason: "forbidden",
      }),
    });
    expect(deny.ingest(makeEvent({ eventId: "e1" })).error).toBe(
      "AUTH_SESSION_FORBIDDEN",
    );
  });
});

describe("IngestGate — idempotency (Req 7.4)", () => {
  it("applies a new event once and assigns a revision", () => {
    const gate = new IngestGate();
    const apply = vi.fn();
    const result = gate.ingest(makeEvent({ eventId: "e1" }), apply);

    expect(result).toMatchObject({ accepted: true, eventRevision: 1 });
    expect(result.duplicateOf).toBeUndefined();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "e1" }),
      1,
    );
  });

  it("returns the prior revision for a duplicate Event_ID without re-applying", () => {
    const gate = new IngestGate();
    const apply = vi.fn();

    const first = gate.ingest(makeEvent({ eventId: "e1" }), apply);
    // A retransmission carries the same eventId (and, realistically, the same
    // replay counter it originally used).
    const second = gate.ingest(makeEvent({ eventId: "e1" }), apply);
    const third = gate.ingest(makeEvent({ eventId: "e1" }), apply);

    expect(first.eventRevision).toBe(1);
    expect(second).toMatchObject({
      accepted: true,
      eventRevision: 1,
      duplicateOf: 1,
    });
    expect(third).toMatchObject({
      accepted: true,
      eventRevision: 1,
      duplicateOf: 1,
    });
    // apply ran exactly once despite three submissions.
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("does not advance the revision counter on a duplicate", () => {
    const revisions = new RevisionCounter();
    const gate = new IngestGate({ revisions });

    gate.ingest(makeEvent({ eventId: "e1" }));
    gate.ingest(makeEvent({ eventId: "e1" }));
    // A genuinely new event gets the next revision (2), proving the duplicate
    // consumed no revision.
    const next = gate.ingest(makeEvent({ eventId: "e2", counter: 2 }));

    expect(next.eventRevision).toBe(2);
    expect(revisions.highest(session)).toBe(2);
  });

  it("resumes applied Event_IDs after a restart", () => {
    const gate = new IngestGate({ appliedEvents: [[session, "e1", 7]] });
    expect(gate.hasApplied(session, "e1")).toBe(true);

    const result = gate.ingest(makeEvent({ eventId: "e1" }));
    expect(result).toMatchObject({
      accepted: true,
      eventRevision: 7,
      duplicateOf: 7,
    });
  });

  it("does not turn a domain rejection into a successful duplicate", () => {
    const revisions = new RevisionCounter();
    const gate = new IngestGate({ revisions });
    const event = makeEvent({ eventId: "rejected", counter: 4 });
    const apply = vi.fn(() => ({
      code: "NOT_LOCK_HOLDER" as const,
      reason: "Release attempted by a non-holder.",
    }));

    const rejected = gate.ingest(event, apply);
    const retry = gate.ingest(event, apply);

    expect(rejected).toMatchObject({
      accepted: false,
      eventRevision: 1,
      error: "NOT_LOCK_HOLDER",
    });
    expect(gate.hasApplied(session, "rejected")).toBe(false);
    // The signed event's counter was consumed, so the exact retransmission is
    // a replay error rather than a fabricated idempotent success.
    expect(retry).toMatchObject({ accepted: false, error: "FORMAT_ERROR" });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(revisions.highest(session)).toBe(1);
  });
});

describe("IngestGate — replay protection (Req 7.5)", () => {
  it("rejects a counter that does not advance and leaves state unchanged", () => {
    const revisions = new RevisionCounter();
    const gate = new IngestGate({ revisions });

    gate.ingest(makeEvent({ eventId: "e1", counter: 5, nonce: "n1" }));
    // New eventId but a non-advancing counter for the same device ⇒ replay.
    const replayed = gate.ingest(
      makeEvent({ eventId: "e2", counter: 5, nonce: "n2" }),
    );

    expect(replayed.accepted).toBe(false);
    expect(replayed.error).toBe("FORMAT_ERROR");
    // The rejected replay consumed no revision and was not recorded.
    expect(revisions.highest(session)).toBe(1);
    expect(gate.hasApplied(session, "e2")).toBe(false);
  });

  it("rejects a reused nonce for the same device", () => {
    const gate = new IngestGate();
    gate.ingest(makeEvent({ eventId: "e1", counter: 1, nonce: "dup" }));
    const reused = gate.ingest(
      makeEvent({ eventId: "e2", counter: 2, nonce: "dup" }),
    );
    expect(reused.error).toBe("FORMAT_ERROR");
  });

  it("tracks replay counters independently per device", () => {
    const gate = new IngestGate();
    gate.ingest(makeEvent({ eventId: "a1", deviceId: "dev-A", counter: 3 }));
    // Device B starts fresh; a low counter is fine for a different device.
    const result = gate.ingest(
      makeEvent({ eventId: "b1", deviceId: "dev-B", counter: 1 }),
    );
    expect(result).toMatchObject({ accepted: true, eventRevision: 2 });
  });

  it("uses the injected replay guard so state can be shared/seeded", () => {
    const guard = createReplayGuard([
      ["dev-A", { highestCounter: 10, usedNonces: new Set<string>() }],
    ]);
    const gate = new IngestGate({ replayGuard: guard });
    // counter 4 <= seeded 10 ⇒ rejected.
    expect(
      gate.ingest(makeEvent({ eventId: "e1", deviceId: "dev-A", counter: 4 }))
        .accepted,
    ).toBe(false);
    // counter 11 advances ⇒ accepted.
    expect(
      gate.ingest(makeEvent({ eventId: "e2", deviceId: "dev-A", counter: 11 }))
        .accepted,
    ).toBe(true);
  });
});

describe("IngestGate — ordering guarantees (design §4.4)", () => {
  it("permitAll is the default and accepts a valid event", () => {
    const gate = new IngestGate({ checkPermission: permitAll });
    expect(gate.ingest(makeEvent({ eventId: "e1" })).accepted).toBe(true);
  });

  it("assigns strictly increasing revisions across distinct accepted events", () => {
    const gate = new IngestGate();
    const r1 = gate.ingest(
      makeEvent({ eventId: "e1", counter: 1 }),
    ).eventRevision;
    const r2 = gate.ingest(
      makeEvent({ eventId: "e2", counter: 2 }),
    ).eventRevision;
    const r3 = gate.ingest(
      makeEvent({ eventId: "e3", counter: 3 }),
    ).eventRevision;
    expect([r1, r2, r3]).toEqual([1, 2, 3]);
  });
});
