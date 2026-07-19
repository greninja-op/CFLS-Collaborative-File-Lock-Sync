/**
 * The thin `vscode` adapter (task 11.1–11.4 wiring; design §3.5).
 *
 * This is the ONLY module that imports the `vscode` API. It translates VS Code
 * events into the pure {@link EditorEvent} stream ({@link VsCodeEditorHost}),
 * renders a {@link CoordinationViewModel} into a status-bar indicator
 * ({@link StatusBarRenderer}), and reads the Local_API connection settings. All
 * coordination logic lives in the pure modules, so the test suite runs under
 * vitest without the VS Code runtime.
 */

import * as vscode from "vscode";

import {
  EmitterEditorHost,
  type EditorEvent,
  type EditorEventKind,
  type EditorHost,
} from "./editor-host";
import type { CoordinationViewModel } from "./view-model";

/** The Local_API connection settings read from workspace configuration. */
export interface LocalApiSettings {
  url: string;
  token: string;
  heartbeatIntervalMs: number;
}

/** Read the extension's Local_API settings from VS Code configuration. */
export function readLocalApiSettings(): LocalApiSettings {
  const config = vscode.workspace.getConfiguration("cfls");
  return {
    url: config.get<string>("localApi.url", "ws://127.0.0.1:8750"),
    token: config.get<string>("localApi.token", ""),
    heartbeatIntervalMs: config.get<number>("heartbeat.intervalMs", 10_000),
  };
}

/** Convert an absolute editor URI to a repository-relative path (Req 10.3). */
export function toRepoRelativePath(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri, false);
}

/**
 * A {@link EditorHost} that bridges VS Code workspace/window events to the pure
 * {@link EditorEvent} stream. Registers its VS Code listeners on construction and
 * releases them on {@link dispose}.
 */
export class VsCodeEditorHost implements EditorHost {
  private readonly emitter = new EmitterEditorHost();
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.wire();
  }

  onEditorEvent(listener: (event: EditorEvent) => void): () => void {
    return this.emitter.onEditorEvent(listener);
  }

  private fire(kind: EditorEventKind, uri?: vscode.Uri, oldUri?: vscode.Uri): void {
    const event: EditorEvent = {
      kind,
      at: Date.now(),
      ...(uri !== undefined ? { path: toRepoRelativePath(uri) } : {}),
      ...(oldUri !== undefined ? { oldPath: toRepoRelativePath(oldUri) } : {}),
    };
    this.emitter.emit(event);
  }

  private wire(): void {
    // workspace_opened: fire once for the currently open workspace.
    if (vscode.workspace.workspaceFolders !== undefined) {
      queueMicrotask(() => this.fire("workspace_opened"));
    }
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.fire("workspace_opened")),
      vscode.workspace.onDidOpenTextDocument((doc) => this.fire("file_opened", doc.uri)),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor !== undefined) {
          this.fire("active_editor_changed", editor.document.uri);
        }
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length > 0) {
          this.fire("editing_started", e.document.uri);
        }
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => this.fire("file_saved", doc.uri)),
      vscode.workspace.onDidCloseTextDocument((doc) => this.fire("file_closed", doc.uri)),
      vscode.workspace.onDidRenameFiles((e) => {
        for (const f of e.files) {
          this.fire("file_renamed", f.newUri, f.oldUri);
        }
      }),
      vscode.workspace.onDidDeleteFiles((e) => {
        for (const uri of e.files) {
          this.fire("file_deleted", uri);
        }
      }),
    );
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}

/** Renders the coordination view model's offline/stale status into a status bar. */
export class StatusBarRenderer {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100,
    );
    this.item.command = "cfls.showCoordinationStatus";
    this.item.show();
  }

  render(vm: CoordinationViewModel): void {
    const icon = vm.offline ? "$(cloud-offline)" : vm.stale ? "$(sync)" : "$(check)";
    // When teammates are active, surface the count right in the status bar so
    // coordination is visible at a glance; otherwise show the plain state.
    const summary =
      !vm.offline && !vm.stale && vm.paths.length > 0
        ? `${vm.paths.length} file(s) in play`
        : vm.statusText;
    this.item.text = `${icon} CFLS: ${summary}`;
    this.item.tooltip =
      vm.paths.length === 0 && vm.plannedFileCreations.length === 0
        ? "No teammates editing tracked files. Run 'CFLS: Show Coordination Status' for details."
        : `${vm.paths.length} coordinated path(s), ${vm.plannedFileCreations.length} planned creation(s). Run 'CFLS: Show Coordination Status' for details.`;
  }

  dispose(): void {
    this.item.dispose();
  }
}
