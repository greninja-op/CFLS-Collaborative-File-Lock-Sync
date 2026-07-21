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
  /** Previous repository-relative path, for a rename or active-editor switch. */
  oldPath?: string;
  /**
   * An authoritative current-editor reassertion after the Local_API connects.
   * It is not a replay of offline activity: the agent reconciles its durable
   * active-editor ownership to this one current state.
   */
  activeEditorSnapshot?: boolean;
  /** Detection time (epoch ms), used to reason about the 2s emission bound. */
  at: number;
}

/**
 * Tracks the one repository file that VS Code currently presents as active.
 *
 * The adapter owns URI-to-repository-path conversion; this small pure state
 * machine owns only the transition semantics. Keeping it here lets tests prove
 * that activation and a tab switch emit the exact safe path pair the agent
 * needs to retire its previous editor-owned presence/lock.
 */
export class ActiveEditorPathTracker {
  private activePath: string | undefined;
  /** Most recent repository path explicitly cleared while no path is active. */
  private lastClearedPath: string | undefined;

  /**
   * Record a newly active repository path. Returns an event payload only when
   * it differs from the previous active path; `undefined` means there is no
   * repository document active (for example, a settings or untitled editor).
   */
  setActive(
    path: string | undefined,
  ): Pick<EditorEvent, "path" | "oldPath"> | undefined {
    if (this.activePath === path) {
      return undefined;
    }
    const oldPath = this.activePath;
    this.activePath = path;
    this.lastClearedPath = path === undefined ? oldPath : undefined;
    return {
      ...(path !== undefined ? { path } : {}),
      ...(oldPath !== undefined ? { oldPath } : {}),
    };
  }

  /**
   * Forget a path once VS Code closes or deletes that document. Returns the
   * old-path-only active-editor transition when it actually cleared the active
   * document, so the agent can retire it immediately.
   */
  clearIfActive(
    path: string | undefined,
  ): Pick<EditorEvent, "path" | "oldPath"> | undefined {
    if (path !== undefined && this.activePath === path) {
      return this.setActive(undefined);
    }
    return undefined;
  }

  /**
   * Keep tracking an active document across a repository-local rename. Moving
   * it outside the repository becomes an old-path-only transition.
   */
  rename(
    fromPath: string | undefined,
    toPath: string | undefined,
  ): Pick<EditorEvent, "path" | "oldPath"> | undefined {
    if (fromPath !== undefined && this.activePath === fromPath) {
      if (toPath === undefined) {
        return this.setActive(undefined);
      }
      this.activePath = toPath;
      this.lastClearedPath = undefined;
    }
    return undefined;
  }

  /**
   * Return the latest safe active-editor state for a Local_API reconnect. When
   * no repository document is active, retain the latest explicit clear as an
   * old-path-only state so a previously announced active file is retired.
   */
  currentState(): Pick<EditorEvent, "path" | "oldPath"> {
    if (this.activePath !== undefined) {
      return { path: this.activePath };
    }
    return this.lastClearedPath === undefined
      ? {}
      : { oldPath: this.lastClearedPath };
  }
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
