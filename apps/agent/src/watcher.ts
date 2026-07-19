/**
 * Authorized_Folder filesystem watcher (task 9.4; Req 2.7, 2.8, 17.1–17.5,
 * 30.1–30.7; design §7.6).
 *
 * The agent watches **only** the Authorized_Folder and **never modifies** files
 * — it reads directory listings and file stats to *confirm persisted* changes
 * (saves, creations, renames/moves, deletions), which it reconciles into
 * coordination updates (Req 2.7, 2.8). Live open/typing signals come from the
 * Editor_Extension's editor events; the watcher's job is only to confirm what
 * actually hit disk (Req 17.x, 30.x).
 *
 * Change detection is a deterministic scan diff: {@link FolderWatcher.scanOnce}
 * compares the current tree against the last known tree and emits typed
 * {@link FileChangeEvent}s, pairing a same-file deletion+creation into a
 * `renamed` event (by inode when available, else size). A real `fs.watch` (with
 * a debounce) drives the same scan when {@link FolderWatcher.start} is used, so
 * tests can invoke {@link FolderWatcher.scanOnce} directly for determinism
 * across platforms.
 */

import { EventEmitter } from "node:events";
import { existsSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { normalizePath } from "@cfls/core-state";

/** The kind of persisted change the watcher confirmed (Req 30). */
export type FileChangeKind = "created" | "saved" | "renamed" | "deleted";

/** A single confirmed persisted change, with repo-relative normalized paths. */
export interface FileChangeEvent {
  kind: FileChangeKind;
  /** Repository-relative normalized path (the new path for a rename). */
  path: string;
  /** For a `renamed` event, the prior repository-relative path (Req 30.1). */
  fromPath?: string;
}

/** Default always-excluded directories (never scanned, Req 29.2 / design §7.6). */
export const DEFAULT_IGNORED_DIRS: readonly string[] = [
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".cache",
  "coverage",
  ".next",
  "vendor",
  ".venv",
  "venv",
];

/** Options for a {@link FolderWatcher}. */
export interface FolderWatcherOptions {
  /** The Authorized_Folder root (absolute). Nothing outside it is ever scanned. */
  folder: string;
  /** Directory names to exclude (defaults to {@link DEFAULT_IGNORED_DIRS}). */
  ignoredDirs?: readonly string[];
  /** Debounce for coalescing rapid fs events before a scan (ms, default 50). */
  debounceMs?: number;
}

/** A recorded file's identity used to diff scans and detect renames. */
interface FileMeta {
  ino: number;
  size: number;
  mtimeMs: number;
}

/**
 * Watches the Authorized_Folder for persisted changes and emits
 * {@link FileChangeEvent}s. Emits `"change"` `(FileChangeEvent)` per confirmed
 * change; never writes to the filesystem.
 */
export class FolderWatcher extends EventEmitter {
  private readonly folder: string;
  private readonly ignored: Set<string>;
  private readonly debounceMs: number;
  private known = new Map<string, FileMeta>();
  private fsWatcher: FSWatcher | undefined;
  private debounceTimer: NodeJS.Timeout | undefined;

  constructor(options: FolderWatcherOptions) {
    super();
    this.folder = resolve(options.folder);
    this.ignored = new Set(options.ignoredDirs ?? DEFAULT_IGNORED_DIRS);
    this.debounceMs = options.debounceMs ?? 50;
  }

  /** Prime the known-file baseline without emitting events (initial state). */
  prime(): void {
    this.known = this.scanTree();
  }

  /**
   * Start watching. Primes the baseline, then wires a debounced `fs.watch` that
   * triggers {@link scanOnce}. Recursive watching is used where supported; the
   * scan diff is the source of truth regardless, so a missed native event only
   * delays (never drops) detection at the next scan.
   */
  start(): void {
    this.prime();
    try {
      this.fsWatcher = watch(this.folder, { recursive: true }, () => {
        this.scheduleScan();
      });
    } catch {
      // Recursive watch may be unsupported on some platforms; the scan-diff API
      // still works when driven manually or by a poll. Do not modify the FS.
      this.fsWatcher = undefined;
    }
  }

  private scheduleScan(): void {
    if (this.debounceTimer !== undefined) {
      return;
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      for (const event of this.scanOnce()) {
        this.emit("change", event);
      }
    }, this.debounceMs);
    this.debounceTimer.unref?.();
  }

  /**
   * Diff the current tree against the last known baseline and return the
   * confirmed changes, updating the baseline. Deterministic and side-effect-free
   * on the filesystem — the primitive used by both `fs.watch` and tests.
   */
  scanOnce(): FileChangeEvent[] {
    const current = this.scanTree();
    const events: FileChangeEvent[] = [];

    const deletions: string[] = [];
    const creations: string[] = [];

    for (const [path, meta] of this.known) {
      const now = current.get(path);
      if (now === undefined) {
        deletions.push(path);
      } else if (now.size !== meta.size || now.mtimeMs !== meta.mtimeMs) {
        events.push({ kind: "saved", path });
      }
    }
    for (const path of current.keys()) {
      if (!this.known.has(path)) {
        creations.push(path);
      }
    }

    // Pair a deletion + creation of the same underlying file as a rename/move
    // (Req 30.1): match by inode when meaningful, else by identical size.
    const unmatchedDeletions: string[] = [];
    const usedCreations = new Set<string>();
    for (const del of deletions) {
      const delMeta = this.known.get(del)!;
      let matched: string | undefined;
      for (const cre of creations) {
        if (usedCreations.has(cre)) {
          continue;
        }
        const creMeta = current.get(cre)!;
        const sameIno = delMeta.ino !== 0 && delMeta.ino === creMeta.ino;
        const sameSize = delMeta.size === creMeta.size;
        if (sameIno || sameSize) {
          matched = cre;
          break;
        }
      }
      if (matched !== undefined) {
        usedCreations.add(matched);
        events.push({ kind: "renamed", path: matched, fromPath: del });
      } else {
        unmatchedDeletions.push(del);
      }
    }

    for (const cre of creations) {
      if (!usedCreations.has(cre)) {
        events.push({ kind: "created", path: cre });
      }
    }
    for (const del of unmatchedDeletions) {
      events.push({ kind: "deleted", path: del });
    }

    this.known = current;
    return events;
  }

  /** Recursively enumerate files under the Authorized_Folder (excluding ignored). */
  private scanTree(): Map<string, FileMeta> {
    const out = new Map<string, FileMeta>();
    if (!existsSync(this.folder)) {
      return out;
    }
    const walk = (dir: string): void => {
      let entries: import("node:fs").Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const abs = resolve(dir, entry.name);
        // Never escape the Authorized_Folder (Req 2.7).
        if (!this.isWithinFolder(abs)) {
          continue;
        }
        if (entry.isDirectory()) {
          if (this.ignored.has(entry.name)) {
            continue;
          }
          walk(abs);
        } else if (entry.isFile()) {
          try {
            const st = statSync(abs);
            out.set(this.toRepoRelative(abs), {
              ino: Number(st.ino),
              size: st.size,
              mtimeMs: st.mtimeMs,
            });
          } catch {
            // File vanished between readdir and stat; skip.
          }
        }
      }
    };
    walk(this.folder);
    return out;
  }

  private isWithinFolder(abs: string): boolean {
    const rel = relative(this.folder, abs);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  }

  private toRepoRelative(abs: string): string {
    const rel = relative(this.folder, abs).split(sep).join("/");
    return normalizePath(rel);
  }

  /** Stop watching (does not touch the filesystem). */
  stop(): void {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    if (this.fsWatcher !== undefined) {
      this.fsWatcher.close();
      this.fsWatcher = undefined;
    }
  }
}

/** A host message to transmit, produced by reconciling a file change. */
export interface ReconciledMessage {
  type:
    | "file.created"
    | "path.renamed"
    | "path.deleted"
    | "presence.report";
  payload: Record<string, unknown>;
}

/**
 * Reconcile a confirmed persisted {@link FileChangeEvent} into the host messages
 * the agent should transmit (Req 17.1–17.5, 30.1–30.7). Renames/moves and
 * deletions become explicit path-change events (Req 30); a create becomes a
 * `file.created`; a save confirms persisted editing activity as a presence
 * report. The watcher only ever *confirms* persisted changes — live open/typing
 * comes from editor events (design §7.6).
 */
export function reconcileFileChange(event: FileChangeEvent): ReconciledMessage[] {
  switch (event.kind) {
    case "created":
      return [{ type: "file.created", payload: { path: event.path } }];
    case "renamed":
      return [
        {
          type: "path.renamed",
          payload: { fromPath: event.fromPath ?? event.path, toPath: event.path },
        },
      ];
    case "deleted":
      return [{ type: "path.deleted", payload: { path: event.path } }];
    case "saved":
      return [
        { type: "presence.report", payload: { path: event.path, state: "editing" } },
      ];
  }
}
