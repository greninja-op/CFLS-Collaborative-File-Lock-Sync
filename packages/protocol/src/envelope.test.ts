/**
 * Unit tests for envelope construction and round-tripping (design §4.2).
 *
 * Task 2.5 — asserts `buildEnvelope` defaults `version` to
 * `MESSAGE_FORMAT_VERSION` and stamps `sentAt`, produces a typed envelope whose
 * `type`/`payload` are consistent, that `toSignedEvent` attaches a signature,
 * and that envelopes survive a construct → canonicalize → parse JSON round-trip
 * with their structure preserved.
 *
 * _Requirements: 7.1, 11.1_
 */

import { describe, it, expect } from "vitest";

import {
  MESSAGE_FORMAT_VERSION,
  buildEnvelope,
  toSignedEvent,
  canonicalize,
  canonicalEnvelopeString,
  type BuildEnvelopeInput,
} from "./envelope";
import { LockMessageType, PresenceMessageType } from "./messages";
import type { SessionId } from "./models";

const SESSION: SessionId = {
  repoId: "git@github.com:acme/widgets",
  teamId: "team-1",
  branch: "main",
  baseRevision: "abc123",
};

function lockAcquireInput(
  overrides: Partial<BuildEnvelopeInput<typeof LockMessageType.ACQUIRE>> = {},
): BuildEnvelopeInput<typeof LockMessageType.ACQUIRE> {
  return {
    type: LockMessageType.ACQUIRE,
    eventId: "evt-1",
    session: SESSION,
    deviceId: "device-1",
    replay: { counter: 1, nonce: "bm9uY2U=" },
    payload: { scope: "src/index.ts", scopeKind: "file", mode: "hard" },
    ...overrides,
  };
}

describe("buildEnvelope", () => {
  it("defaults version to MESSAGE_FORMAT_VERSION when omitted", () => {
    const env = buildEnvelope(lockAcquireInput());
    expect(env.version).toBe(MESSAGE_FORMAT_VERSION);
  });

  it("honors an explicit version override", () => {
    const env = buildEnvelope(lockAcquireInput({ version: 99 }));
    expect(env.version).toBe(99);
  });

  it("stamps sentAt with a valid ISO-8601 timestamp when omitted", () => {
    const before = Date.now();
    const env = buildEnvelope(lockAcquireInput());
    const after = Date.now();

    expect(typeof env.sentAt).toBe("string");
    const parsed = Date.parse(env.sentAt);
    expect(Number.isNaN(parsed)).toBe(false);
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
  });

  it("honors an explicit sentAt", () => {
    const sentAt = "2024-01-01T00:00:00.000Z";
    const env = buildEnvelope(lockAcquireInput({ sentAt }));
    expect(env.sentAt).toBe(sentAt);
  });

  it("produces an envelope whose type and payload are consistent with the input", () => {
    const input = lockAcquireInput();
    const env = buildEnvelope(input);

    expect(env.type).toBe(LockMessageType.ACQUIRE);
    expect(env.eventId).toBe(input.eventId);
    expect(env.session).toEqual(SESSION);
    expect(env.deviceId).toBe(input.deviceId);
    expect(env.payload).toEqual(input.payload);
  });

  it("copies the replay guard (counter + nonce) into the envelope", () => {
    const env = buildEnvelope(
      lockAcquireInput({ replay: { counter: 7, nonce: "YWJj" } }),
    );
    expect(env.replay).toEqual({ counter: 7, nonce: "YWJj" });
  });

  it("narrows the payload by message type for a different catalog entry", () => {
    const env = buildEnvelope({
      type: PresenceMessageType.REPORT,
      eventId: "evt-2",
      session: SESSION,
      deviceId: "device-2",
      replay: { counter: 2, nonce: "bm9uY2Uy" },
      payload: { path: "src/app.ts", state: "editing" },
    });

    expect(env.type).toBe("presence.report");
    expect(env.payload).toEqual({ path: "src/app.ts", state: "editing" });
  });
});

describe("toSignedEvent", () => {
  it("attaches the signature and preserves the envelope reference", () => {
    const env = buildEnvelope(lockAcquireInput());
    const signed = toSignedEvent(env, "c2lnbmF0dXJl");

    expect(signed.signature).toBe("c2lnbmF0dXJl");
    expect(signed.envelope).toBe(env);
  });
});

describe("canonicalize", () => {
  it("sorts object keys recursively so structurally-equal values match", () => {
    const a = canonicalize({ b: 1, a: { d: 4, c: 3 } });
    const b = canonicalize({ a: { c: 3, d: 4 }, b: 1 });
    expect(a).toBe(b);
  });

  it("preserves array order", () => {
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
  });

  it("drops undefined object properties", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("is stable regardless of envelope key insertion order", () => {
    const env = buildEnvelope(lockAcquireInput({ sentAt: "2024-01-01T00:00:00.000Z" }));
    // Rebuild the same logical envelope with keys in a shuffled order.
    const shuffled = {
      payload: env.payload,
      signature: undefined,
      sentAt: env.sentAt,
      replay: { nonce: env.replay.nonce, counter: env.replay.counter },
      deviceId: env.deviceId,
      session: env.session,
      eventId: env.eventId,
      version: env.version,
      type: env.type,
    };
    expect(canonicalize(env)).toBe(canonicalize(shuffled));
  });
});

describe("envelope JSON round-trip", () => {
  it("survives construct → canonicalize → JSON.parse preserving structure", () => {
    const env = buildEnvelope(lockAcquireInput({ sentAt: "2024-01-01T00:00:00.000Z" }));

    const serialized = canonicalize(env);
    const parsed = JSON.parse(serialized) as typeof env;

    expect(parsed).toEqual(env);
  });

  it("re-canonicalizes to identical bytes after a parse round-trip (signable stability)", () => {
    const env = buildEnvelope(lockAcquireInput({ sentAt: "2024-01-01T00:00:00.000Z" }));

    const first = canonicalEnvelopeString(env);
    const parsed = JSON.parse(JSON.stringify(env)) as typeof env;
    const second = canonicalEnvelopeString(parsed);

    expect(second).toBe(first);
  });

  it("canonicalEnvelopeString excludes the signature field", () => {
    const env = buildEnvelope(lockAcquireInput({ sentAt: "2024-01-01T00:00:00.000Z" }));
    const signed = toSignedEvent(env, "c2lnbmF0dXJl");

    // A signed event round-trips through JSON and its envelope's canonical form
    // is unchanged by the presence of the detached signature.
    const parsed = JSON.parse(JSON.stringify(signed)) as typeof signed;
    expect(canonicalEnvelopeString(parsed.envelope)).toBe(canonicalEnvelopeString(env));
    expect(canonicalEnvelopeString(env)).not.toContain("c2lnbmF0dXJl");
  });

  it("a SignedEvent survives a full JSON round-trip preserving envelope and signature", () => {
    const env = buildEnvelope(lockAcquireInput({ sentAt: "2024-01-01T00:00:00.000Z" }));
    const signed = toSignedEvent(env, "c2lnbmF0dXJl");

    const parsed = JSON.parse(JSON.stringify(signed)) as typeof signed;
    expect(parsed).toEqual(signed);
  });
});
