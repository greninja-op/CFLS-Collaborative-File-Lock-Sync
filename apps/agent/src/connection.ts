/**
 * The agent's single outbound persistent WSS connection to the CoordinationHost
 * (task 9.1; Req 2.3, 6.1–6.6, 33.1, 33.3; design §3.2, §4.1, §8.4).
 *
 * One {@link HostConnection} owns exactly one WSS/TLS socket. It performs the
 * Ed25519 challenge-response handshake (design §4.1), sends the agent's
 * Signed_Events, receives `coordination.update` broadcasts and `sync.*`
 * responses, and sends periodic heartbeats (Req 26.6). On connection loss it
 * enters **Offline_State** (Req 6.4) and reconnects with exponential backoff
 * (Req 6.6); while offline it never claims hard-lock safety — mutations are
 * refused with `OFFLINE_QUEUED` (Req 4.8) and callers surface connectivity +
 * staleness (Req 33.1, 33.3). It reports connectivity via
 * {@link HostConnection.snapshot}.
 */

import { EventEmitter } from "node:events";
import { sign } from "node:crypto";
import { randomUUID, randomBytes } from "node:crypto";

import {
  buildEnvelope,
  MESSAGE_FORMAT_VERSION,
  type CoordinationUpdate,
  type MessagePayloadMap,
  type MessageTypeName,
  type SessionId,
  type SessionStateSnapshot,
} from "@cfls/protocol";
import {
  deriveDeviceId,
  privateKeyObject,
  signEnvelope,
  type DeviceKey,
} from "@cfls/security";
import type { ConnectionSnapshot } from "@cfls/mcp-server";
import { WebSocket } from "ws";

import {
  ExponentialBackoff,
  type BackoffOptions,
} from "./backoff";

/** The reconnect-safe sync response shape (mirrors core-state `SyncResponse`). */
export type SyncResponse =
  | { kind: "events"; events: CoordinationUpdate[] }
  | { kind: "snapshot"; snapshot: SessionStateSnapshot };

/** Connectivity state of the single WSS connection. */
export type ConnectionState = "offline" | "connecting" | "online";

/** Options for a {@link HostConnection}. */
export interface HostConnectionOptions {
  /** The configured Host_URL (`wss://…`); never hardcoded (Req 6.2). */
  hostUrl: string;
  /** The Repository_Session to authenticate for. */
  session: SessionId;
  /** The agent's Ed25519 Device_Key. */
  deviceKey: DeviceKey;
  /** base64 Signed_Invitation chaining to an admin (Req 5.5). */
  invitation: string;
  /**
   * Skip TLS certificate validation. ONLY for local dev/test hosts using a
   * self-signed certificate; never in production (design §4.1).
   */
  insecureTls?: boolean;
  /** Heartbeat interval in ms (Req 26.6); 0 disables. Default 10s. */
  heartbeatIntervalMs?: number;
  /** Exponential backoff tuning for reconnects (Req 6.6). */
  backoff?: BackoffOptions;
  /** Whether to auto-reconnect on loss (default true). */
  autoReconnect?: boolean;
  /** Injectable clock for deterministic staleness. */
  now?: () => number;
  /** Injectable WebSocket implementation (tests). */
  webSocketImpl?: typeof WebSocket;
}

/** A dynamically-shaped inbound wire message. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WireMessage = any;

/** Outcome of transmitting a Signed_Event to the host. */
export type SendResult =
  | { ok: true; eventId: string }
  | { ok: false; code: "OFFLINE_QUEUED"; message: string };

/**
 * A single outbound WSS connection to the CoordinationHost. Emits:
 *   - `"update"` `(CoordinationUpdate)` — a broadcast coordination change.
 *   - `"state"`  `(ConnectionState)`    — connectivity transitions.
 *   - `"online"` `()`                   — a handshake just completed (drive sync).
 *   - `"error"`  `({code,message})`     — a host-side error message.
 */
/** Resolved connection parameters (all defaults filled in). */
interface ResolvedConnectionParams {
  hostUrl: string;
  session: SessionId;
  deviceKey: DeviceKey;
  invitation: string;
  heartbeatIntervalMs: number;
  autoReconnect: boolean;
  insecureTls: boolean;
}

export class HostConnection extends EventEmitter {
  private readonly options: ResolvedConnectionParams;
  private readonly backoff: ExponentialBackoff;
  private readonly WebSocketImpl: typeof WebSocket;
  private readonly now: () => number;

  private ws: WebSocket | undefined;
  private state: ConnectionState = "offline";
  private replayCounter = 0;
  private lastSyncAt: string | null = null;
  private highestRevision = 0;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private closedByUser = false;

  /** One-shot message waiters (like a request/response correlator). */
  private waiters: Array<{
    predicate: (m: WireMessage) => boolean;
    resolve: (m: WireMessage) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(options: HostConnectionOptions) {
    super();
    this.options = {
      hostUrl: options.hostUrl,
      session: options.session,
      deviceKey: options.deviceKey,
      invitation: options.invitation,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 10_000,
      autoReconnect: options.autoReconnect ?? true,
      insecureTls: options.insecureTls ?? false,
    };
    this.backoff = new ExponentialBackoff(options.backoff ?? {});
    this.WebSocketImpl = options.webSocketImpl ?? WebSocket;
    this.now = options.now ?? Date.now;
  }

  /** Current connectivity state. */
  connectionState(): ConnectionState {
    return this.state;
  }

  /** Whether the connection is currently online. */
  isOnline(): boolean {
    return this.state === "online";
  }

  /** The highest Event_Revision the host reported at handshake / via updates. */
  currentHighestRevision(): number {
    return this.highestRevision;
  }

  /** The connectivity snapshot stamped on MCP/Local_API responses (Req 4.7). */
  snapshot(): ConnectionSnapshot {
    return {
      status: this.state === "online" ? "online" : "offline",
      hostUrl: this.options.hostUrl,
      lastSyncAt: this.lastSyncAt,
    };
  }

  /** Seconds since the last successful sync, or `null` when never synced. */
  secondsSinceSync(): number | null {
    if (this.lastSyncAt === null) {
      return null;
    }
    return Math.max(0, Math.floor((this.now() - Date.parse(this.lastSyncAt)) / 1000));
  }

  /**
   * Open the connection and complete the handshake (design §4.1). Resolves once
   * `auth.ok` is received (online); rejects if the initial handshake fails. On a
   * later loss the connection auto-reconnects with backoff (Req 6.6) unless
   * {@link close} was called.
   */
  async connect(): Promise<void> {
    this.closedByUser = false;
    await this.openOnce();
  }

  private setState(next: ConnectionState): void {
    if (this.state !== next) {
      this.state = next;
      this.emit("state", next);
    }
  }

  private openOnce(): Promise<void> {
    this.setState("connecting");
    return new Promise<void>((resolve, reject) => {
      const ws = new this.WebSocketImpl(this.options.hostUrl, {
        rejectUnauthorized: this.options.insecureTls !== true,
      });
      this.ws = ws;

      ws.on("message", (data: unknown) => this.onMessage(String(data)));
      ws.on("close", () => this.onClose());
      ws.on("error", (err: Error) => {
        // Surface the first error to the initial connect() caller; later errors
        // drive the reconnect loop via "close".
        if (this.state === "connecting") {
          reject(err);
        }
      });

      ws.once("open", () => {
        this.handshake()
          .then((highestRevision) => {
            this.highestRevision = highestRevision;
            // NOTE: replayCounter is intentionally NOT reset — the per-device
            // monotonic counter must keep increasing across reconnects, or the
            // host rejects re-asserted events as replays (Req 7.5).
            this.backoff.reset();
            this.lastSyncAt = new Date(this.now()).toISOString();
            this.setState("online");
            this.startHeartbeat();
            this.emit("online");
            resolve();
          })
          .catch((err: Error) => {
            this.teardownSocket();
            this.setState("offline");
            reject(err);
          });
      });
    });
  }

  private async handshake(): Promise<number> {
    this.raw({
      type: "auth.hello",
      payload: {
        devicePublicKey: this.options.deviceKey.publicKey,
        session: this.options.session,
        signedInvitation: this.options.invitation,
        version: MESSAGE_FORMAT_VERSION,
      },
    });
    const challenge = await this.waitFor(
      (m) => m?.type === "auth.challenge" || m?.type === "auth.error",
      8000,
    );
    if (challenge.type === "auth.error") {
      throw new Error(`Handshake rejected: ${challenge.payload?.code}`);
    }
    const nonce: string = challenge.payload.nonce;
    this.raw({
      type: "auth.response",
      payload: { signature: this.signChallenge(nonce) },
    });
    const ok = await this.waitFor(
      (m) => m?.type === "auth.ok" || m?.type === "auth.error",
      8000,
    );
    if (ok.type === "auth.error") {
      throw new Error(`Handshake rejected: ${ok.payload?.code}`);
    }
    return typeof ok.payload?.highestRevision === "number"
      ? ok.payload.highestRevision
      : 0;
  }

  /** Sign the challenge nonce with the Device_Private_Key (design §4.1). */
  private signChallenge(nonce: string): string {
    return sign(
      null,
      Buffer.from(nonce, "utf8"),
      privateKeyObject(this.options.deviceKey.privateKey),
    ).toString("base64");
  }

  private onMessage(raw: string): void {
    let message: WireMessage;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    // Resolve any correlated waiters first.
    this.waiters = this.waiters.filter((w) => {
      if (w.predicate(message)) {
        clearTimeout(w.timer);
        w.resolve(message);
        return false;
      }
      return true;
    });

    if (message?.type === "coordination.update") {
      const update = message.payload as CoordinationUpdate;
      if (update.eventRevision > this.highestRevision) {
        this.highestRevision = update.eventRevision;
      }
      this.emit("update", update);
      return;
    }
    if (message?.type === "error") {
      this.emit("error", message.payload);
      return;
    }
  }

  private onClose(): void {
    this.teardownSocket();
    // Reject pending waiters so callers do not hang on a dropped socket.
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.reject(new Error("Connection closed."));
    }
    this.waiters = [];
    if (this.closedByUser) {
      this.setState("offline");
      return;
    }
    this.setState("offline");
    if (this.options.autoReconnect) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== undefined) {
      return;
    }
    const delay = this.backoff.nextDelay();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.closedByUser) {
        return;
      }
      this.openOnce().catch(() => {
        // openOnce failed; onClose (or the catch here) reschedules.
        if (!this.closedByUser && this.reconnectTimer === undefined) {
          this.scheduleReconnect();
        }
      });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private startHeartbeat(): void {
    const interval = this.options.heartbeatIntervalMs;
    if (interval <= 0) {
      return;
    }
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.state !== "online") {
        return;
      }
      this.send("heartbeat.ping", { sentAt: new Date(this.now()).toISOString() });
    }, interval);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private teardownSocket(): void {
    this.stopHeartbeat();
    if (this.ws !== undefined) {
      this.ws.removeAllListeners();
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = undefined;
    }
  }

  /**
   * Transmit a Signed_Event to the host (Req 7.1). Returns `OFFLINE_QUEUED`
   * without sending when offline, so callers never falsely report host
   * acceptance (Req 4.8). The `eventId` is returned so callers can correlate the
   * host's broadcast/ack.
   */
  send<T extends MessageTypeName>(
    type: T,
    payload: MessagePayloadMap[T],
  ): SendResult {
    if (this.state !== "online" || this.ws === undefined) {
      return {
        ok: false,
        code: "OFFLINE_QUEUED",
        message: `Agent offline; '${type}' not transmitted to the host.`,
      };
    }
    const eventId = randomUUID();
    this.replayCounter += 1;
    const envelope = buildEnvelope({
      type,
      eventId,
      session: this.options.session,
      deviceId: deriveDeviceId(this.options.deviceKey.publicKey),
      replay: { counter: this.replayCounter, nonce: randomBytes(12).toString("base64") },
      payload,
    });
    const signed = signEnvelope(envelope, this.options.deviceKey.privateKey);
    this.ws.send(JSON.stringify(signed));
    return { ok: true, eventId };
  }

  /**
   * Request reconnect sync from `fromRevision` (Req 9.2). Resolves with the
   * host's incremental events or a snapshot fallback (Req 9.3, 9.5); rejects
   * when offline or on timeout.
   */
  async requestSync(fromRevision: number, timeoutMs = 8000): Promise<SyncResponse> {
    if (this.state !== "online") {
      throw new Error("Cannot sync while offline.");
    }
    const result = this.send("sync.request", { fromRevision });
    if (!result.ok) {
      throw new Error("Cannot sync while offline.");
    }
    const message = await this.waitFor(
      (m) => m?.type === "sync.events" || m?.type === "sync.snapshot",
      timeoutMs,
    );
    this.lastSyncAt = new Date(this.now()).toISOString();
    if (message.type === "sync.events") {
      const events = (message.payload.events ?? []) as CoordinationUpdate[];
      for (const e of events) {
        if (e.eventRevision > this.highestRevision) {
          this.highestRevision = e.eventRevision;
        }
      }
      return { kind: "events", events };
    }
    const snapshot = message.payload.state as SessionStateSnapshot;
    if (snapshot.highestRevision > this.highestRevision) {
      this.highestRevision = snapshot.highestRevision;
    }
    return { kind: "snapshot", snapshot };
  }

  /**
   * Wait for the next inbound message matching `predicate` (or a broadcast that
   * already matched is not buffered — waiters are forward-looking). Used to
   * correlate a mutation with its resulting `coordination.update` or `error`.
   */
  waitFor(
    predicate: (m: WireMessage) => boolean,
    timeoutMs = 4000,
  ): Promise<WireMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(new Error("Timed out waiting for host message."));
      }, timeoutMs);
      timer.unref?.();
      this.waiters.push({ predicate, resolve, reject, timer });
    });
  }

  private raw(message: unknown): void {
    this.ws?.send(JSON.stringify(message));
  }

  /** Close the connection and stop reconnecting. */
  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.teardownSocket();
    this.setState("offline");
  }

  /**
   * Force the connection offline WITHOUT tearing down auto-reconnect intent —
   * used by tests to simulate a transient network drop (Req 6.4).
   */
  simulateDrop(): void {
    if (this.ws !== undefined) {
      this.ws.close();
    }
  }
}
