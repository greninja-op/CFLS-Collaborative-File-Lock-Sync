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
 * `renamed` event only when a stable filesystem identity proves it. When an
 * inode is unavailable, CFLS safely reports a create plus delete rather than
 * guessing and migrating coordination state to an unrelated file. A real recursive
 * `fs.watch` (with a debounce) drives the same scan when available. When that
 * facility is unavailable or fails at runtime, a single polling reconciler
 * drives the same scan instead. Tests can invoke {@link FolderWatcher.scanOnce}
 * directly for determinism across platforms.
 */

import { EventEmitter } from "node:events";
import {
  existsSync,
  readdirSync,
  statSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { normalizePath } from "@cfls/core-state";
import { isExcludedPath } from "@cfls/dependency-analyzer";

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
  // CFLS's local cache/discovery token and the editor's settings live inside
  // the watched folder but are not project source — never coordinate on them.
  ".coordination",
  ".cfls-cache",
  ".vscode",
];

/** Default reconciliation interval when recursive native watching is unavailable. */
export const DEFAULT_POLL_INTERVAL_MS = 1_000;

/** Options for a {@link FolderWatcher}. */
export interface FolderWatcherOptions {
  /** The Authorized_Folder root (absolute). Nothing outside it is ever scanned. */
  folder: string;
  /** Directory names to exclude (defaults to {@link DEFAULT_IGNORED_DIRS}). */
  ignoredDirs?: readonly string[];
  /** Debounce for coalescing rapid fs events before a scan (ms, default 50). */
  debounceMs?: number;
  /**
   * Reconciliation interval used only when recursive native watching is
   * unavailable or fails (ms, default {@link DEFAULT_POLL_INTERVAL_MS}).
   */
  pollIntervalMs?: number;
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
  private readonly pollIntervalMs: number;
  private known = new Map<string, FileMeta>();
  private fsWatcher: FSWatcher | undefined;
  private debounceTimer: NodeJS.Timeout | undefined;
  private pollingTimer: NodeJS.Timeout | undefined;
  private started = false;

  constructor(options: FolderWatcherOptions) {
    super();
    this.folder = resolve(options.folder);
    this.ignored = new Set(options.ignoredDirs ?? DEFAULT_IGNORED_DIRS);
    this.debounceMs = options.debounceMs ?? 50;
    this.pollIntervalMs = this.resolvePollInterval(options.pollIntervalMs);
  }

  /** Prime the known-file baseline without emitting events (initial state). */
  prime(): void {
    this.known = this.scanTree();
  }

  /**
   * Start watching. Primes the baseline, then wires a debounced recursive
   * `fs.watch` that triggers {@link scanOnce}. If recursive watching is not
   * supported or later reports an error, a single polling reconciler takes over.
   * Calling `start` while already running is intentionally a no-op so a retry or
   * duplicate lifecycle signal can never create duplicate polling intervals.
   */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.prime();
    let openedWatcher: FSWatcher | undefined;
    try {
      const fsWatcher = watch(this.folder, { recursive: true }, () => {
        this.scheduleScan();
      });
      openedWatcher = fsWatcher;
      this.fsWatcher = fsWatcher;
      // An `error` event without a listener is fatal in Node. Treat an error or
      // unexpected close as a signal to reconcile via polling instead.
      fsWatcher.on("error", () => this.handleNativeWatcherFailure(fsWatcher));
      fsWatcher.on("close", () => this.handleNativeWatcherFailure(fsWatcher));
    } catch {
      // Recursive watch is unavailable on some platforms. The scan-diff remains
      // the source of truth; polling makes that fallback automatic.
      if (this.fsWatcher === openedWatcher) {
        this.fsWatcher = undefined;
        try {
          openedWatcher?.close();
        } catch {
          // A partially initialized watcher may already be closed.
        }
      }
      this.startPolling();
    }
  }

  /** Switch a failed native watcher to the one-and-only polling reconciler. */
  private handleNativeWatcherFailure(fsWatcher: FSWatcher): void {
    // Ignore notifications from a watcher that has been stopped or superseded.
    if (this.fsWatcher !== fsWatcher) {
      return;
    }
    this.fsWatcher = undefined;
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    try {
      fsWatcher.close();
    } catch {
      // It may already be closed; polling is still safe and sufficient.
    }
    this.startPolling();
  }

  /** Start periodic reconciliation exactly once, only while running. */
  private startPolling(): void {
    if (
      !this.started ||
      this.fsWatcher !== undefined ||
      this.pollingTimer !== undefined
    ) {
      return;
    }
    this.pollingTimer = setInterval(() => {
      this.emitScan();
    }, this.pollIntervalMs);
  }

  private scheduleScan(): void {
    if (
      !this.started ||
      this.fsWatcher === undefined ||
      this.debounceTimer !== undefined
    ) {
      return;
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.emitScan();
    }, this.debounceMs);
    this.debounceTimer.unref?.();
  }

  /** Reconcile one scan and emit each confirmed persisted change. */
  private emitScan(): void {
    for (const event of this.scanOnce()) {
      this.emit("change", event);
    }
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
    // (Req 30.1) only when both scans expose the same stable inode. A size or
    // timestamp match is not identity: coarse-time/network filesystems can give
    // two independent files both values. It is safer to report a real rename as
    // create/delete than to migrate coordination state across unrelated files.
    const candidatesByDeletion = new Map<string, string[]>();
    const candidatesByCreation = new Map<string, string[]>();
    for (const del of deletions) {
      const delMeta = this.known.get(del)!;
      for (const cre of creations) {
        const creMeta = current.get(cre)!;
        if (!this.isRenameCandidate(delMeta, creMeta)) {
          continue;
        }
        const deletionCandidates = candidatesByDeletion.get(del) ?? [];
        deletionCandidates.push(cre);
        candidatesByDeletion.set(del, deletionCandidates);
        const creationCandidates = candidatesByCreation.get(cre) ?? [];
        creationCandidates.push(del);
        candidatesByCreation.set(cre, creationCandidates);
      }
    }

    const unmatchedDeletions: string[] = [];
    const usedCreations = new Set<string>();
    for (const del of deletions) {
      const candidates = candidatesByDeletion.get(del) ?? [];
      const matched = candidates.length === 1 ? candidates[0] : undefined;
      if (
        matched !== undefined &&
        (candidatesByCreation.get(matched)?.length ?? 0) === 1 &&
        !usedCreations.has(matched)
      ) {
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

  /**
   * Return true only when two scan entries have the same stable filesystem
   * identity. Without that proof, never infer a rename from metadata alone.
   */
  private isRenameCandidate(before: FileMeta, after: FileMeta): boolean {
    const beforeHasInode = Number.isSafeInteger(before.ino) && before.ino > 0;
    const afterHasInode = Number.isSafeInteger(after.ino) && after.ino > 0;
    return beforeHasInode && afterHasInode && before.ino === after.ino;
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
        const repoRelative = this.toRepoRelative(abs);
        if (entry.isDirectory()) {
          if (this.ignored.has(entry.name) || isExcludedPath(repoRelative)) {
            continue;
          }
          walk(abs);
        } else if (entry.isFile()) {
          if (isExcludedPath(repoRelative)) {
            continue;
          }
          try {
            const st = statSync(abs);
            out.set(repoRelative, {
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

  private resolvePollInterval(value: number | undefined): number {
    if (value === undefined) {
      return DEFAULT_POLL_INTERVAL_MS;
    }
    // Avoid an accidental busy loop from a malformed external configuration.
    return Number.isFinite(value) && value > 0
      ? value
      : DEFAULT_POLL_INTERVAL_MS;
  }

  /** Stop watching (does not touch the filesystem). */
  stop(): void {
    this.started = false;
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    if (this.pollingTimer !== undefined) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = undefined;
    }
    if (this.fsWatcher !== undefined) {
      const fsWatcher = this.fsWatcher;
      this.fsWatcher = undefined;
      try {
        fsWatcher.close();
      } catch {
        // A failed native watcher may already be closed. Nothing to clean up.
      }
    }
  }
}

/** A host message to transmit, produced by reconciling a file change. */
export interface ReconciledMessage {
  type: "file.created" | "path.renamed" | "path.deleted" | "presence.report";
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
export function reconcileFileChange(
  event: FileChangeEvent,
): ReconciledMessage[] {
  switch (event.kind) {
    case "created":
      return [{ type: "file.created", payload: { path: event.path } }];
    case "renamed":
      return [
        {
          type: "path.renamed",
          payload: {
            fromPath: event.fromPath ?? event.path,
            toPath: event.path,
          },
        },
      ];
    case "deleted":
      return [{ type: "path.deleted", payload: { path: event.path } }];
    case "saved":
      return [
        {
          type: "presence.report",
          payload: { path: event.path, state: "editing" },
        },
      ];
  }
}
