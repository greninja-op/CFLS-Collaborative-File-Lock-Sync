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

  constructor(url: string, socketImpl: typeof WebSocket = WebSocket) {
    if (!isLoopbackUrl(url)) {
      throw new Error(
        `Local_API URL '${url}' is not loopback; the Editor_Extension only ` +
          `connects to the local CoordinationAgent (Req 3.1).`,
      );
    }
    this.socket = new socketImpl(url);
    this.socket.on("open", () => {
      this.open = true;
    });
    this.socket.on("close", () => {
      this.open = false;
    });
  }

  send(frame: unknown): void {
    this.socket.send(JSON.stringify(frame));
  }

  onMessage(handler: (raw: string) => void): void {
    this.socket.on("message", (data: unknown) => handler(String(data)));
  }

  onOpen(handler: () => void): void {
    this.socket.on("open", () => handler());
  }

  onClose(handler: () => void): void {
    this.socket.on("close", () => handler());
  }

  isOpen(): boolean {
    return this.open;
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      /* ignore */
    }
  }
}
