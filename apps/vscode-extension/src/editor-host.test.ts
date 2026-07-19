/**
 * Unit tests for the {@link EditorHost} abstraction and {@link EditorEventForwarder}
 * — editor-event emission within 2 seconds (task 11.2, 11.5; Req 3.2). Uses the
 * in-memory {@link EmitterEditorHost}, so no VS Code runtime is required.
 */

import { describe, expect, it } from "vitest";

import {
  EditorEventForwarder,
  EmitterEditorHost,
  type EditorEvent,
  type EditorEventKind,
} from "./editor-host";

const ALL_KINDS: EditorEventKind[] = [
  "workspace_opened",
  "file_opened",
  "active_editor_changed",
  "editing_started",
  "file_saved",
  "file_closed",
  "file_renamed",
  "file_deleted",
];

describe("EditorEventForwarder (Req 3.2)", () => {
  it("forwards all eight editor event kinds to the sink", () => {
    const host = new EmitterEditorHost();
    const received: EditorEvent[] = [];
    new EditorEventForwarder(host, (e) => received.push(e));

    for (const kind of ALL_KINDS) {
      host.emit({ kind, at: Date.now(), path: `src/${kind}.ts` });
    }

    expect(received.map((e) => e.kind)).toEqual(ALL_KINDS);
  });

  it("forwards each event synchronously (well within the 2s bound)", () => {
    const host = new EmitterEditorHost();
    let sinkCalledAt: number | undefined;
    new EditorEventForwarder(host, (e) => {
      sinkCalledAt = Date.now();
      // The event's detection timestamp and the forward happen essentially at
      // once — far inside the 2 second emission requirement (Req 3.2).
      expect(sinkCalledAt - e.at).toBeLessThan(2_000);
    });

    const before = Date.now();
    host.emit({ kind: "editing_started", at: before, path: "src/a.ts" });
    expect(sinkCalledAt).toBeGreaterThanOrEqual(before);
  });

  it("carries the renamed path pair for file_renamed", () => {
    const host = new EmitterEditorHost();
    const received: EditorEvent[] = [];
    new EditorEventForwarder(host, (e) => received.push(e));

    host.emit({
      kind: "file_renamed",
      at: Date.now(),
      path: "src/new.ts",
      oldPath: "src/old.ts",
    });

    expect(received[0]).toMatchObject({
      kind: "file_renamed",
      path: "src/new.ts",
      oldPath: "src/old.ts",
    });
  });

  it("stops forwarding after dispose", () => {
    const host = new EmitterEditorHost();
    const received: EditorEvent[] = [];
    const forwarder = new EditorEventForwarder(host, (e) => received.push(e));

    host.emit({ kind: "file_opened", at: Date.now(), path: "src/a.ts" });
    forwarder.dispose();
    host.emit({ kind: "file_opened", at: Date.now(), path: "src/b.ts" });

    expect(received).toHaveLength(1);
  });
});
