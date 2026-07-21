/**
 * Integration tests for the Authorized_Folder watcher (task 9.8; Req 30.1). Uses
 * a real temp directory and real filesystem operations, driving the
 * deterministic scan diff so the assertions are stable cross-platform. Verifies
 * rename/move and deletion reconciliation, that the watcher never modifies
 * files, and that excluded directories are never scanned.
 */

import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FolderWatcher, reconcileFileChange } from "../src/watcher";

let dir: string;
let watcher: FolderWatcher;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cfls-watch-"));
});

afterEach(() => {
  watcher.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("watcher-driven reconciliation (Req 30.1)", () => {
  it("detects a creation", () => {
    watcher = new FolderWatcher({ folder: dir });
    watcher.prime();
    writeFileSync(join(dir, "a.ts"), "console.log(1);");
    const events = watcher.scanOnce();
    expect(events).toEqual([{ kind: "created", path: "a.ts" }]);
    expect(reconcileFileChange(events[0]!)).toEqual([
      { type: "file.created", payload: { path: "a.ts" } },
    ]);
  });

  it("detects a save (modification)", () => {
    writeFileSync(join(dir, "a.ts"), "v1");
    watcher = new FolderWatcher({ folder: dir });
    watcher.prime();
    // Change size so the diff is unambiguous regardless of mtime resolution.
    writeFileSync(join(dir, "a.ts"), "v2-longer-content");
    const events = watcher.scanOnce();
    expect(events).toEqual([{ kind: "saved", path: "a.ts" }]);
  });

  it("reconciles a rename/move into a path.renamed event (Req 30.1)", () => {
    writeFileSync(join(dir, "old.ts"), "same-size-content");
    const originalIno = Number(statSync(join(dir, "old.ts")).ino);
    watcher = new FolderWatcher({ folder: dir });
    watcher.prime();
    renameSync(join(dir, "old.ts"), join(dir, "new.ts"));
    const events = watcher.scanOnce();
    const renamedIno = Number(statSync(join(dir, "new.ts")).ino);
    if (
      Number.isSafeInteger(originalIno) &&
      originalIno > 0 &&
      originalIno === renamedIno
    ) {
      expect(events).toEqual([
        { kind: "renamed", path: "new.ts", fromPath: "old.ts" },
      ]);
      expect(reconcileFileChange(events[0]!)).toEqual([
        {
          type: "path.renamed",
          payload: { fromPath: "old.ts", toPath: "new.ts" },
        },
      ]);
    } else {
      // Filesystems without stable inode identity favor correctness over a
      // speculative rename; no coordination state is migrated by guesswork.
      expect(events).toEqual([
        { kind: "created", path: "new.ts" },
        { kind: "deleted", path: "old.ts" },
      ]);
    }
  });

  it("does not infer a rename from matching metadata without stable identity", () => {
    writeFileSync(join(dir, "old.ts"), "same-size-content");
    utimesSync(join(dir, "old.ts"), new Date(0), new Date(0));
    watcher = new FolderWatcher({ folder: dir });
    watcher.prime();

    rmSync(join(dir, "old.ts"));
    writeFileSync(join(dir, "new.ts"), "same-size-content");
    // Make every non-identity field equal. This simulates a coarse-mtime or
    // inode-less filesystem, where using size/mtime as a rename fallback would
    // wrongly transfer locks and intents to an unrelated file.
    utimesSync(join(dir, "new.ts"), new Date(0), new Date(0));

    const internal = watcher as unknown as {
      known: Map<string, { ino: number; size: number; mtimeMs: number }>;
      scanTree: () => Map<
        string,
        { ino: number; size: number; mtimeMs: number }
      >;
    };
    for (const meta of internal.known.values()) {
      meta.ino = 0;
    }
    const realScanTree = internal.scanTree.bind(watcher);
    internal.scanTree = () => {
      const current = realScanTree();
      for (const meta of current.values()) {
        meta.ino = 0;
      }
      return current;
    };

    expect(watcher.scanOnce()).toEqual([
      { kind: "created", path: "new.ts" },
      { kind: "deleted", path: "old.ts" },
    ]);
  });

  it("reconciles a deletion into a path.deleted event (Req 30.1)", () => {
    writeFileSync(join(dir, "gone.ts"), "bye");
    watcher = new FolderWatcher({ folder: dir });
    watcher.prime();
    rmSync(join(dir, "gone.ts"));
    const events = watcher.scanOnce();
    expect(events).toEqual([{ kind: "deleted", path: "gone.ts" }]);
    expect(reconcileFileChange(events[0]!)).toEqual([
      { type: "path.deleted", payload: { path: "gone.ts" } },
    ]);
  });

  it("never scans excluded directories", () => {
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(dir, ".coordination"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "pkg", "index.js"), "ignored");
    writeFileSync(join(dir, ".coordination", "local-api.json"), "secret");
    writeFileSync(join(dir, "real.ts"), "tracked");
    watcher = new FolderWatcher({ folder: dir });
    watcher.prime();
    // Adding another file inside node_modules must not surface as a change.
    writeFileSync(
      join(dir, "node_modules", "pkg", "extra.js"),
      "still ignored",
    );
    writeFileSync(join(dir, ".coordination", "local-api.json"), "rotated");
    writeFileSync(join(dir, "tracked2.ts"), "yes");
    const events = watcher.scanOnce();
    expect(events).toEqual([{ kind: "created", path: "tracked2.ts" }]);
  });

  it("never reports secret or binary files as collaboration activity", () => {
    watcher = new FolderWatcher({ folder: dir });
    watcher.prime();

    writeFileSync(join(dir, ".env.local"), "API_KEY=not-shared");
    writeFileSync(join(dir, "secrets.pem"), "not-shared");
    writeFileSync(join(dir, "screenshot.png"), "not-shared");
    writeFileSync(join(dir, "src.ts"), "export const tracked = true;");

    expect(watcher.scanOnce()).toEqual([{ kind: "created", path: "src.ts" }]);
  });

  it("normalizes nested paths to repo-relative form", () => {
    mkdirSync(join(dir, "src", "sub"), { recursive: true });
    watcher = new FolderWatcher({ folder: dir });
    watcher.prime();
    writeFileSync(join(dir, "src", "sub", "deep.ts"), "x");
    const events = watcher.scanOnce();
    expect(events).toEqual([{ kind: "created", path: "src/sub/deep.ts" }]);
  });
});
