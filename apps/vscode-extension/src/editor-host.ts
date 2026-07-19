/**
 * The {@link EditorHost} abstraction (task 11.2; Req 3.2; design §3.5).
 *
 * The real VS Code event wiring (workspace/window/text-document listeners) lives
 * in the thin `vscode` adapter; everything else depends only on this interface.
 * That keeps the detect-and-forward logic unit-testable with a fake host, with
 * no running VS Code runtime.
 *
 * The eight {@link EditorEventKind}s mirror the design's `EditorEventKind` union
 * exactly (Req 3.2). {@link EditorEventForwarder} forwards each event to the
 * agent synchronously on receipt, so the "within 2 seconds" bound (Req 3.2) is
 * met by construction.
 */

/** The eight editor activities the extension reports to the agent (Req 3.2). */
export type EditorEventKind =
  | "workspace_opened"
  | "file_opened"
  | "active_editor_changed"
  | "editing_started"
  | "file_saved"
  | "file_closed"
  | "file_renamed"
  | "file_deleted";

/** A detected editor activity, carrying the repository-relative path(s). */
export interface EditorEvent {
  kind: EditorEventKind;
  /** Repository-relative path; absent only for `workspace_opened`. */
  path?: string;
  /** Previous repository-relative path, for `file_renamed`. */
  oldPath?: string;
  /** Detection time (epoch ms), used to reason about the 2s emission bound. */
  at: number;
}

/**
 * The editor runtime the forwarder observes. The `vscode` adapter implements this
 * by translating VS Code events; tests implement it with an in-memory fake.
 */
export interface EditorHost {
  /**
   * Register a listener for raw editor events. Returns an unsubscribe function.
   */
  onEditorEvent(listener: (event: EditorEvent) => void): () => void;
}

/** The sink an {@link EditorEventForwarder} pushes detected events into. */
export type EditorEventSink = (event: EditorEvent) => void;

/**
 * Wires an {@link EditorHost} to an {@link EditorEventSink}, forwarding every
 * detected {@link EditorEvent} synchronously (Req 3.2). Disposing unsubscribes
 * from the host.
 */
export class EditorEventForwarder {
  private readonly unsubscribe: () => void;
  private disposed = false;

  constructor(host: EditorHost, sink: EditorEventSink) {
    this.unsubscribe = host.onEditorEvent((event) => {
      if (!this.disposed) {
        sink(event);
      }
    });
  }

  dispose(): void {
    if (!this.disposed) {
      this.disposed = true;
      this.unsubscribe();
    }
  }
}

/**
 * A simple in-memory {@link EditorHost} that fans a triggered event out to all
 * listeners. Used by the adapter to bridge VS Code events and by tests to drive
 * the forwarder deterministically.
 */
export class EmitterEditorHost implements EditorHost {
  private readonly listeners = new Set<(event: EditorEvent) => void>();

  onEditorEvent(listener: (event: EditorEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Emit an editor event to every registered listener. */
  emit(event: EditorEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
