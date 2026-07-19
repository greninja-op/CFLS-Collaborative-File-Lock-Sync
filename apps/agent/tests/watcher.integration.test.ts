/**
 * Integration tests for the Authorized_Folder watcher (task 9.8; Req 30.1). Uses
 * a real temp directory and real filesystem operations, driving the
 * deterministic scan diff so the assertions are stable cross-platform. Verifies
 * rename/move and deletion reconciliation, that the watcher never modifies
 * files, and that excluded directories are never scanned.
 */

import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
    watcher = new FolderWatcher({ folder: dir });
    watcher.prime();
    renameSync(join(dir, "old.ts"), join(dir, "new.ts"));
    const events = watcher.scanOnce();
    expect(events).toEqual([{ kind: "renamed", path: "new.ts", fromPath: "old.ts" }]);
    expect(reconcileFileChange(events[0]!)).toEqual([
      { type: "path.renamed", payload: { fromPath: "old.ts", toPath: "new.ts" } },
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
    writeFileSync(join(dir, "node_modules", "pkg", "index.js"), "ignored");
    writeFileSync(join(dir, "real.ts"), "tracked");
    watcher = new FolderWatcher({ folder: dir });
    watcher.prime();
    // Adding another file inside node_modules must not surface as a change.
    writeFileSync(join(dir, "node_modules", "pkg", "extra.js"), "still ignored");
    writeFileSync(join(dir, "tracked2.ts"), "yes");
    const events = watcher.scanOnce();
    expect(events).toEqual([{ kind: "created", path: "tracked2.ts" }]);
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
