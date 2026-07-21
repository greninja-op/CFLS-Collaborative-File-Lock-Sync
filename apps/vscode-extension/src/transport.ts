/**
 * The {@link FrameTransport} seam between the {@link LocalApiClient} and the
 * actual loopback socket. Keeping the socket behind this interface lets the
 * client's connect/auth/heartbeat/dispatch logic be unit-tested with an
 * in-memory fake, with **no** running agent or WebSocket runtime.
 *
 * {@link WebSocketFrameTransport} is the production implementation: a loopback
 * `ws` WebSocket to the agent's Local_API. The extension only ever dials
 * `ws://127.0.0.1:*` / `ws://localhost:*` — it never connects to the
 * CoordinationHost (Req 3.1).
 */

import { WebSocket } from "ws";

/** A bidirectional JSON-frame channel to the local CoordinationAgent. */
export interface FrameTransport {
  /** Serialize and send one frame to the agent. */
  send(frame: unknown): void;
  /** Register the handler invoked for each raw inbound frame line. */
  onMessage(handler: (raw: string) => void): void;
  /** Register the handler invoked when the transport opens. */
  onOpen(handler: () => void): void;
  /** Register the handler invoked when the transport closes. */
  onClose(handler: () => void): void;
  /** Whether the transport is currently open. */
  isOpen(): boolean;
  /** Close the transport. */
  close(): void;
}

/** Loopback-address guard: the extension only ever dials the local agent (Req 3.1). */
export function isLoopbackUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return (
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "localhost" ||
    host === "[::1]"
  );
}

/** A production {@link FrameTransport} over a loopback `ws` WebSocket. */
export class WebSocketFrameTransport implements FrameTransport {
  private readonly socket: WebSocket;
  private open = false;
  /**
   * A loopback socket can fail before it ever opens (for example while the
   * per-user agent service is restarting). Keep one terminal marker so an
   * `error` followed by `close` is observed as one connection loss by callers.
   */
  private terminal = false;
  private readonly closeHandlers = new Set<() => void>();
  /**
   * Frames enqueued before the socket finished opening. The client authenticates
   * as soon as it is constructed, which can race ahead of the WebSocket `open`
   * event; buffering here guarantees the `auth` frame (and any early request) is
   * delivered in order once the socket is ready, rather than being dropped.
   */
  private readonly pending: string[] = [];

  constructor(url: string, socketImpl: typeof WebSocket = WebSocket) {
    if (!isLoopbackUrl(url)) {
      throw new Error(
        `Local_API URL '${url}' is not loopback; the Editor_Extension only ` +
          `connects to the local CoordinationAgent (Req 3.1).`,
      );
    }
    this.socket = new socketImpl(url);
    this.socket.on("open", () => {
      if (this.terminal) {
        return;
      }
      this.open = true;
      const queued = this.pending.splice(0, this.pending.length);
      for (const frame of queued) {
        this.socket.send(frame);
      }
    });
    // `ws` emits an EventEmitter `error` for a refused connection. Without a
    // listener that error can take down the extension host before it has a
    // chance to show its offline state. Treat both failure signals as one
    // terminal transport close; the reconnect owner will build a fresh socket
    // with the newly rotated discovery URL/token.
    this.socket.on("error", () => this.markTerminal());
    this.socket.on("close", () => this.markTerminal());
  }

  send(frame: unknown): void {
    const serialized = JSON.stringify(frame);
    if (this.open && this.socket.readyState === this.socket.OPEN) {
      this.socket.send(serialized);
      return;
    }
    if (!this.terminal && this.socket.readyState === this.socket.CONNECTING) {
      // Not open yet: buffer and flush on the `open` event (avoids a lost auth
      // frame that would otherwise leave the extension stuck Offline).
      this.pending.push(serialized);
      return;
    }
    // Never retain requests (especially mutations) for a dead connection. A
    // reconnect must establish a fresh client and let the caller decide whether
    // a new action is appropriate; silently replaying a stale request would be
    // unsafe.
    throw new Error("The Local_API WebSocket is not available.");
  }

  onMessage(handler: (raw: string) => void): void {
    this.socket.on("message", (data: unknown) => handler(String(data)));
  }

  onOpen(handler: () => void): void {
    this.socket.on("open", () => handler());
  }

  onClose(handler: () => void): void {
    this.closeHandlers.add(handler);
    if (this.terminal) {
      queueMicrotask(handler);
    }
  }

  isOpen(): boolean {
    return this.open;
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      this.markTerminal();
    }
  }

  /** Notify close observers exactly once for an error/close lifecycle. */
  private markTerminal(): void {
    if (this.terminal) {
      return;
    }
    this.terminal = true;
    this.open = false;
    this.pending.length = 0;
    for (const handler of this.closeHandlers) {
      try {
        handler();
      } catch {
        // One extension consumer cannot prevent the rest from observing the
        // Local_API loss and starting their own safe cleanup.
      }
    }
  }
}
