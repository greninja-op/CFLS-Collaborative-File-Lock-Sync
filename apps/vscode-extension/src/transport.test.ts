/** Regression coverage for terminal Local_API WebSocket failures. */

import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { WebSocketFrameTransport } from "./transport";

/** Minimal EventEmitter-backed WebSocket constructor for transport tests. */
class FakeWebSocket extends EventEmitter {
  static latest: FakeWebSocket | undefined;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readyState = this.CONNECTING;
  readonly sent: string[] = [];

  constructor(_url: string) {
    super();
    FakeWebSocket.latest = this;
  }

  send(frame: string): void {
    this.sent.push(frame);
  }

  close(): void {
    this.readyState = 3;
    this.emit("close");
  }

  open(): void {
    this.readyState = this.OPEN;
    this.emit("open");
  }

  refuseConnection(): void {
    this.readyState = 3;
    // EventEmitter throws for an unhandled `error`; this call itself proves the
    // transport has installed the required listener.
    this.emit("error", new Error("connection refused"));
  }
}

describe("WebSocketFrameTransport terminal failures", () => {
  it("handles an error/close pair once and never replays buffered frames", () => {
    const transport = new WebSocketFrameTransport(
      "ws://127.0.0.1:8750",
      FakeWebSocket as unknown as typeof WebSocket,
    );
    const socket = FakeWebSocket.latest;
    expect(socket).toBeDefined();
    if (socket === undefined) {
      throw new Error("test WebSocket was not created");
    }

    let closeCount = 0;
    transport.onClose(() => {
      closeCount += 1;
    });
    transport.send({ type: "auth", token: "old-token" });

    socket.refuseConnection();
    expect(closeCount).toBe(1);
    expect(transport.isOpen()).toBe(false);
    expect(() => transport.send({ type: "request", id: 1 })).toThrow(
      /not available/,
    );

    // `ws` normally emits close after error. It must not begin a second
    // reconnect cycle, and the old auth frame must never flush on a late open.
    socket.emit("close");
    socket.open();
    expect(closeCount).toBe(1);
    expect(socket.sent).toEqual([]);
  });
});
