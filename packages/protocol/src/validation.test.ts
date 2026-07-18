/**
 * Unit tests for schema and message-format-version validation (task 2.4).
 *
 * Covers, per the design §4.4 / §4.7 validation gate:
 *   - Accepted payloads per representative message type (valid envelopes pass
 *     validateEnvelope / validatePayload).
 *   - Rejected payloads: missing / mistyped required fields → FORMAT_ERROR.
 *   - Unsupported version (version != MESSAGE_FORMAT_VERSION) → FORMAT_ERROR.
 *   - Unknown message type → FORMAT_ERROR.
 *   - validateSignedEvent: missing / non-string signature → FORMAT_ERROR;
 *     a valid signed event passes.
 *   - Canonicalization stability: canonicalize produces identical output for
 *     structurally-equal objects regardless of key order.
 *
 * _Requirements: 7.6, 7.7_
 */

import { describe, it, expect } from "vitest";

import {
  MESSAGE_FORMAT_VERSION,
  buildEnvelope,
  canonicalize,
  canonicalEnvelopeString,
  type ReplayGuard,
} from "./envelope";
import { MessageType, MESSAGE_TYPES } from "./messages";
import {
  validateEnvelope,
  validatePayload,
  validateSignedEvent,
  PAYLOAD_SCHEMAS,
} from "./validation";
import type { SessionId } from "./models";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const session: SessionId = {
  repoId: "github.com/acme/widgets",
  teamId: "team-1",
  branch: "main",
  baseRevision: null,
};

const replay: ReplayGuard = { counter: 1, nonce: "bm9uY2U=" };

/** A minimal, well-formed lock.acquire envelope used as the "happy path" base. */
function validLockAcquireEnvelope() {
  return buildEnvelope({
    type: MessageType.ACQUIRE, // "lock.acquire"
    eventId: "evt-1",
    session,
    deviceId: "dev-1",
    replay,
    payload: { scope: "src/api.ts", scopeKind: "file", mode: "soft" },
  });
}

// ---------------------------------------------------------------------------
// Accepted payloads per representative message type
// ---------------------------------------------------------------------------

describe("validatePayload — accepted payloads", () => {
  it("accepts a valid lock.acquire payload", () => {
    const result = validatePayload(MessageType.ACQUIRE, {
      scope: "src/api.ts",
      scopeKind: "file",
      mode: "hard",
    });
    expect(result.ok).toBe(true);
  });

  it("accepts a valid presence.report payload", () => {
    const result = validatePayload(MessageType.REPORT, {
      path: "src/api.ts",
      state: "editing",
    });
    expect(result.ok).toBe(true);
  });

  it("accepts a valid intent.declare payload", () => {
    const result = validatePayload(MessageType.DECLARE, {
      modifyPaths: ["src/a.ts"],
      createPaths: ["src/new.ts"],
      description: "refactor auth",
    });
    expect(result.ok).toBe(true);
  });

  it("accepts a valid sync.request payload", () => {
    const result = validatePayload(MessageType.REQUEST, { fromRevision: 42 });
    expect(result.ok).toBe(true);
  });

  it("accepts a valid coordination.update payload", () => {
    const result = validatePayload(MessageType.UPDATE, {
      entryType: "soft_lock",
      op: "added",
      path: "src/api.ts",
      member: { memberId: "u-1", deviceId: "dev-1" },
      eventRevision: 7,
    });
    expect(result.ok).toBe(true);
  });

  it("permits unknown extra keys (forward-compatibility)", () => {
    const result = validatePayload(MessageType.REQUEST, {
      fromRevision: 42,
      futureField: "ignored",
    });
    expect(result.ok).toBe(true);
  });

  it("permits omission of optional fields (heartbeat.ping)", () => {
    const result = validatePayload(MessageType.PING, {});
    expect(result.ok).toBe(true);
  });
});

describe("validateEnvelope — accepted envelopes", () => {
  it("accepts a fully valid lock.acquire envelope", () => {
    const result = validateEnvelope(validLockAcquireEnvelope());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.type).toBe("lock.acquire");
      expect(result.envelope.version).toBe(MESSAGE_FORMAT_VERSION);
    }
  });

  it("accepts every catalog message type paired with a schema", () => {
    // Sanity: every message type has a registered payload schema.
    for (const type of MESSAGE_TYPES) {
      expect(PAYLOAD_SCHEMAS[type]).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Rejected payloads: missing / mistyped required fields → FORMAT_ERROR
// ---------------------------------------------------------------------------

describe("validatePayload — rejected payloads", () => {
  it("rejects a missing required field with FORMAT_ERROR", () => {
    const result = validatePayload(MessageType.ACQUIRE, {
      scope: "src/api.ts",
      scopeKind: "file",
      // mode missing
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("FORMAT_ERROR");
      expect(result.error.message).toContain("mode");
    }
  });

  it("rejects a mistyped required field with FORMAT_ERROR", () => {
    const result = validatePayload(MessageType.REQUEST, {
      fromRevision: "not-a-number",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("FORMAT_ERROR");
    }
  });

  it("rejects an out-of-range enum value with FORMAT_ERROR", () => {
    const result = validatePayload(MessageType.ACQUIRE, {
      scope: "src/api.ts",
      scopeKind: "directory", // not a ScopeKind
      mode: "soft",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("FORMAT_ERROR");
    }
  });

  it("rejects a non-object payload with FORMAT_ERROR", () => {
    const result = validatePayload(MessageType.REQUEST, 123);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("FORMAT_ERROR");
    }
  });

  it("rejects a wrong element type inside an array with FORMAT_ERROR", () => {
    const result = validatePayload(MessageType.DECLARE, {
      modifyPaths: ["src/a.ts", 5],
      createPaths: [],
      description: "x",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("FORMAT_ERROR");
    }
  });
});

describe("validateEnvelope — rejected envelopes", () => {
  it("rejects an envelope whose payload is missing a required field", () => {
    const env = validLockAcquireEnvelope();
    // Drop the required `mode` field from the payload.
    const broken = {
      ...env,
      payload: { scope: "src/api.ts", scopeKind: "file" },
    };
    const result = validateEnvelope(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("FORMAT_ERROR");
      // Error should reference the offending event for traceability.
      expect(result.error.refEventId).toBe("evt-1");
    }
  });

  it("rejects an envelope missing a required top-level field", () => {
    const env = validLockAcquireEnvelope() as Record<string, unknown>;
    delete env.deviceId;
    const result = validateEnvelope(env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("FORMAT_ERROR");
      expect(result.error.message).toContain("deviceId");
    }
  });

  it("rejects a non-object envelope", () => {
    const result = validateEnvelope(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("FORMAT_ERROR");
    }
  });
});

// ---------------------------------------------------------------------------
// Unsupported version → FORMAT_ERROR (Req 7.6)
// ---------------------------------------------------------------------------

describe("validateEnvelope — version validation", () => {
  it("rejects an unsupported message-format version with FORMAT_ERROR", () => {
    const env = { ...validLockAcquireEnvelope(), version: MESSAGE_FORMAT_VERSION + 1 };
    const result = validateEnvelope(env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("FORMAT_ERROR");
      expect(result.error.message).toContain("version");
    }
  });

  it("rejects version 0 with FORMAT_ERROR", () => {
    const env = { ...validLockAcquireEnvelope(), version: 0 };
    const result = validateEnvelope(env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("FORMAT_ERROR");
    }
  });

  it("accepts the supported version", () => {
    const env = { ...validLockAcquireEnvelope(), version: MESSAGE_FORMAT_VERSION };
    expect(validateEnvelope(env).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unknown message type → FORMAT_ERROR
// ---------------------------------------------------------------------------

describe("unknown message type → FORMAT_ERROR", () => {
  it("validateEnvelope rejects an unknown type", () => {
    const env = { ...validLockAcquireEnvelope(), type: "lock.explode" };
    const result = validateEnvelope(env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("FORMAT_ERROR");
      expect(result.error.message).toContain("unknown message type");
    }
  });

  it("validatePayload rejects an unknown type", () => {
    // Cast through unknown since the arg is intentionally not a MessageTypeName.
    const result = validatePayload(
      "not.a.real.type" as unknown as typeof MessageType.ACQUIRE,
      {},
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("FORMAT_ERROR");
      expect(result.error.message).toContain("unknown message type");
    }
  });
});

// ---------------------------------------------------------------------------
// validateSignedEvent
// ---------------------------------------------------------------------------

describe("validateSignedEvent", () => {
  it("accepts a valid signed event", () => {
    const result = validateSignedEvent({
      envelope: validLockAcquireEnvelope(),
      signature: "c2lnbmF0dXJl",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.signedEvent.signature).toBe("c2lnbmF0dXJl");
      expect(result.signedEvent.envelope.type).toBe("lock.acquire");
    }
  });

  it("rejects a missing signature with FORMAT_ERROR", () => {
    const result = validateSignedEvent({ envelope: validLockAcquireEnvelope() });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("FORMAT_ERROR");
      expect(result.error.message).toContain("signature");
    }
  });

  it("rejects a non-string signature with FORMAT_ERROR", () => {
    const result = validateSignedEvent({
      envelope: validLockAcquireEnvelope(),
      signature: 12345,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("FORMAT_ERROR");
      expect(result.error.message).toContain("signature");
    }
  });

  it("rejects a non-object input with FORMAT_ERROR", () => {
    const result = validateSignedEvent("nope");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("FORMAT_ERROR");
    }
  });

  it("propagates envelope validation failure (FORMAT_ERROR)", () => {
    const result = validateSignedEvent({
      envelope: { ...validLockAcquireEnvelope(), version: 999 },
      signature: "c2ln",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("FORMAT_ERROR");
    }
  });
});

// ---------------------------------------------------------------------------
// Canonicalization stability
// ---------------------------------------------------------------------------

describe("canonicalize — stability regardless of key order", () => {
  it("produces identical output for structurally-equal objects with different key order", () => {
    const a = { b: 1, a: 2, c: { y: 1, x: 2 } };
    const b = { c: { x: 2, y: 1 }, a: 2, b: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it("preserves array order (arrays are not reordered)", () => {
    expect(canonicalize([1, 2, 3])).not.toBe(canonicalize([3, 2, 1]));
    expect(canonicalize([1, 2, 3])).toBe(canonicalize([1, 2, 3]));
  });

  it("drops undefined object properties deterministically", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
  });

  it("distinguishes structurally different objects", () => {
    expect(canonicalize({ a: 1 })).not.toBe(canonicalize({ a: 2 }));
  });

  it("canonicalEnvelopeString is order-independent and excludes the signature", () => {
    const env = validLockAcquireEnvelope();
    // Rebuild the same envelope from a differently-ordered object literal.
    const reordered = {
      payload: env.payload,
      sentAt: env.sentAt,
      replay: env.replay,
      deviceId: env.deviceId,
      session: env.session,
      eventId: env.eventId,
      version: env.version,
      type: env.type,
    };
    expect(canonicalEnvelopeString(env)).toBe(canonicalEnvelopeString(reordered));
    // A stray signature field must not affect the canonical string.
    const withSig = { ...env, signature: "should-be-ignored" };
    expect(canonicalEnvelopeString(withSig)).toBe(canonicalEnvelopeString(env));
  });
});
