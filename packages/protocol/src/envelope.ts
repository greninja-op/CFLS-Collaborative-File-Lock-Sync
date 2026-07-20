/**
 * The versioned wire envelope: the format version, typed builder/helpers over the
 * `EventEnvelope`/`SignedEvent` DTOs, and the canonical serialization used for
 * signing.
 *
 * Mirrors design.md §4.2 "Message Envelope (typed, versioned, signed)".
 *
 * Signing itself lives in `@cfls/security`, but the envelope — and therefore the
 * exact bytes a signature covers — is owned by the protocol package. The
 * canonicalization here is that single source of truth: signer and verifier MUST
 * both feed {@link canonicalEnvelopeString} to Ed25519.
 */

import type { EventEnvelope, SignedEvent, SessionId } from "./models";
import type { MessageTypeName, MessagePayloadMap } from "./messages";

/**
 * The current message-format version (Req 7.1, 7.6). Bumped only on a
 * wire-incompatible change; the host rejects unsupported versions with
 * `FORMAT_ERROR`.
 */
export const MESSAGE_FORMAT_VERSION = 1 as const;

/** The message-format version literal type. */
export type MessageFormatVersion = typeof MESSAGE_FORMAT_VERSION;

/** Per-device replay-protection data carried by every envelope (Req 7.5). */
export interface ReplayGuard {
  /** Per-device monotonic counter; a counter ≤ last-seen is rejected. */
  counter: number;
  /** Single-use base64 nonce. */
  nonce: string;
}

/**
 * A typed envelope whose `payload` is narrowed by its `type` via
 * {@link MessagePayloadMap}. Structurally assignable to {@link EventEnvelope}.
 */
export interface TypedEventEnvelope<
  T extends MessageTypeName = MessageTypeName,
> extends EventEnvelope {
  type: T;
  payload: MessagePayloadMap[T];
}

/** Inputs required to construct an envelope; `version` and `sentAt` default. */
export interface BuildEnvelopeInput<T extends MessageTypeName> {
  type: T;
  eventId: string;
  session: SessionId;
  deviceId: string;
  replay: ReplayGuard;
  payload: MessagePayloadMap[T];
  /** ISO-8601 send time; advisory only, never a sole conflict resolver (Req 8.3). */
  sentAt?: string;
  /** Defaults to {@link MESSAGE_FORMAT_VERSION}. */
  version?: number;
}

/**
 * Build a typed {@link EventEnvelope}, filling in `version`
 * ({@link MESSAGE_FORMAT_VERSION}) and `sentAt` (now) when omitted.
 */
export function buildEnvelope<T extends MessageTypeName>(
  input: BuildEnvelopeInput<T>,
): TypedEventEnvelope<T> {
  return {
    type: input.type,
    version: input.version ?? MESSAGE_FORMAT_VERSION,
    eventId: input.eventId,
    session: input.session,
    deviceId: input.deviceId,
    replay: { counter: input.replay.counter, nonce: input.replay.nonce },
    sentAt: input.sentAt ?? new Date().toISOString(),
    payload: input.payload,
  };
}

/** Attach a base64 Ed25519 `signature` to an envelope, producing a `SignedEvent`. */
export function toSignedEvent(
  envelope: EventEnvelope,
  signature: string,
): SignedEvent {
  return { envelope, signature };
}

/**
 * Deterministically serialize an arbitrary JSON value: object keys are recursively
 * sorted, arrays keep their order, and `undefined` object properties are dropped.
 * Two structurally-equal values always produce identical strings, which is what
 * makes a detached signature verifiable across processes and languages.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const v = source[key];
    if (v !== undefined) {
      sorted[key] = sortValue(v);
    }
  }
  return sorted;
}

/**
 * Produce the canonical string a signature covers, per §4.2:
 * `canonical(type, version, eventId, session, deviceId, replay, sentAt, payload)`.
 *
 * The `signature` field itself is intentionally excluded. Sign and verify by
 * passing this string's UTF-8 bytes to Ed25519.
 */
export function canonicalEnvelopeString(envelope: EventEnvelope): string {
  const { type, version, eventId, session, deviceId, replay, sentAt, payload } =
    envelope;
  return canonicalize({
    type,
    version,
    eventId,
    session,
    deviceId,
    replay,
    sentAt,
    payload,
  });
}
