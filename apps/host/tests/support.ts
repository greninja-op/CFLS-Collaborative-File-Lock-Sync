/**
 * Shared test support for the host integration/unit tests: device identities,
 * signed invitations, signed events, and a minimal WSS client that performs the
 * Ed25519 challenge-response handshake.
 */

import { WebSocket } from "ws";

import {
  buildEnvelope,
  MESSAGE_FORMAT_VERSION,
  type MessagePayloadMap,
  type MessageTypeName,
  type SessionId,
  type SignedEvent,
} from "@cfls/protocol";
import {
  deriveDeviceId,
  generateDeviceKey,
  issueInvitation,
  signEnvelope,
  type DeviceKey,
} from "@cfls/security";

import { signChallenge } from "../src/challenge";

/** Build a test SessionId. */
export function makeSession(overrides: Partial<SessionId> = {}): SessionId {
  return {
    repoId: "github.com/acme/app",
    teamId: "team-1",
    branch: "main",
    baseRevision: null,
    ...overrides,
  };
}

/** A device identity plus its member id for tests. */
export interface TestDevice {
  key: DeviceKey;
  memberId: string;
}

export function makeDevice(memberId: string): TestDevice {
  return { key: generateDeviceKey(), memberId };
}

/**
 * Issue a base64-encoded Signed_Invitation for `device`, signed by `admin`
 * (the session's admin device). An admin admits itself by passing its own key
 * as both issuer and invitee.
 */
export function invitationFor(
  session: SessionId,
  admin: DeviceKey,
  device: TestDevice,
): string {
  const invitation = issueInvitation(
    {
      session,
      devicePublicKey: device.key.publicKey,
      memberId: device.memberId,
      issuerPublicKey: admin.publicKey,
    },
    admin.privateKey,
  );
  return Buffer.from(JSON.stringify(invitation), "utf8").toString("base64");
}

/** Monotonic per-device replay counter source for tests. */
export class Counter {
  private value = 0;
  next(): number {
    this.value += 1;
    return this.value;
  }
}

/** Build a SignedEvent of `type` from `device` for `session`. */
export function signedEvent<T extends MessageTypeName>(
  type: T,
  payload: MessagePayloadMap[T],
  args: {
    session: SessionId;
    device: TestDevice;
    counter: number;
    eventId: string;
    nonce?: string;
  },
): SignedEvent {
  const envelope = buildEnvelope({
    type,
    eventId: args.eventId,
    session: args.session,
    deviceId: deviceIdOf(args.device),
    replay: { counter: args.counter, nonce: args.nonce ?? `n-${args.eventId}` },
    payload,
    version: MESSAGE_FORMAT_VERSION,
  });
  return signEnvelope(envelope, args.device.key.privateKey);
}

/** The deterministic deviceId derived from a device's public key. */
export function deviceIdOf(device: TestDevice): string {
  return deriveDeviceId(device.key.publicKey);
}

/**
 * Wire messages are dynamically-shaped JSON; a permissive alias keeps test
 * assertions ergonomic without sprinkling casts through every test.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WireMessage = any;

/** A connected, authenticated WSS test client. */
export class TestClient {
  private readonly ws: WebSocket;
  private readonly inbox: WireMessage[] = [];
  private waiters: Array<{
    predicate: (m: WireMessage) => boolean;
    resolve: (m: WireMessage) => void;
  }> = [];
  private readonly counter = new Counter();
  highestRevision = 0;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data) => {
      const message = JSON.parse(data.toString());
      this.inbox.push(message);
      this.waiters = this.waiters.filter((w) => {
        if (w.predicate(message)) {
          w.resolve(message);
          return false;
        }
        return true;
      });
    });
  }

  /** Open a raw connection (no handshake). Accepts the dev self-signed cert. */
  static async open(url: string): Promise<TestClient> {
    const ws = new WebSocket(url, { rejectUnauthorized: false });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return new TestClient(ws);
  }

  /** Wait for a message matching `predicate` (or time out). */
  waitFor(
    predicate: (m: WireMessage) => boolean,
    timeoutMs = 4000,
  ): Promise<WireMessage> {
    const existing = this.inbox.find((m) => predicate(m));
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timed out waiting for message")),
        timeoutMs,
      );
      this.waiters.push({
        predicate,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  /** Wait for a message of a given `type` field. */
  waitForType(type: string, timeoutMs = 4000): Promise<WireMessage> {
    return this.waitFor((m) => m?.type === type, timeoutMs);
  }

  private raw(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  /** Send a Signed_Event over the connection. */
  sendEvent(event: SignedEvent): void {
    this.raw(event);
  }

  /** Next replay counter for events sent by this client's device. */
  nextCounter(): number {
    return this.counter.next();
  }

  close(): void {
    this.ws.close();
  }

  /**
   * Perform the full auth handshake. Resolves to `{ ok: true }` on `auth.ok`
   * (recording the highest revision) or `{ ok: false, code }` on `auth.error`.
   */
  async handshake(
    session: SessionId,
    device: TestDevice,
    invitationB64: string,
  ): Promise<{ ok: true } | { ok: false; code: string }> {
    this.raw({
      type: "auth.hello",
      payload: {
        devicePublicKey: device.key.publicKey,
        session,
        signedInvitation: invitationB64,
        version: MESSAGE_FORMAT_VERSION,
      },
    });
    const first = await this.waitFor(
      (m) => m?.type === "auth.challenge" || m?.type === "auth.error",
    );
    if (first.type === "auth.error") {
      return { ok: false, code: first.payload.code };
    }
    const nonce: string = first.payload.nonce;
    this.raw({
      type: "auth.response",
      payload: { signature: signChallenge(nonce, device.key.privateKey) },
    });
    const second = await this.waitFor(
      (m) => m?.type === "auth.ok" || m?.type === "auth.error",
    );
    if (second.type === "auth.error") {
      return { ok: false, code: second.payload.code };
    }
    this.highestRevision = second.payload.highestRevision;
    return { ok: true };
  }
}
