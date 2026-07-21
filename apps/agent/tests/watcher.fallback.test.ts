/**
 * Lifecycle coverage for the cross-platform fallback behind FolderWatcher.
 * Native recursive watching is mocked here so these cases remain deterministic
 * even on platforms that do support it.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nativeWatchMock = vi.hoisted(() => ({
  mode: "native" as "native" | "throw" | "error",
  listeners: new Map<string, Array<() => void>>(),
  closeCalls: 0,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const realWatch = actual.watch as unknown as (...args: unknown[]) => unknown;

  return {
    ...actual,
    watch: (...args: unknown[]) => {
      if (nativeWatchMock.mode === "throw") {
        throw new Error("recursive watching is unavailable");
      }
      if (nativeWatchMock.mode === "error") {
        const listeners = new Map<string, Array<() => void>>();
        nativeWatchMock.listeners = listeners;
        const watcher = {
          on(event: string, listener: () => void) {
            const eventListeners = listeners.get(event) ?? [];
            eventListeners.push(listener);
            listeners.set(event, eventListeners);
            return watcher;
          },
          close() {
            nativeWatchMock.closeCalls += 1;
            for (const listener of listeners.get("close") ?? []) {
              listener();
            }
          },
        };
        return watcher;
      }
      return realWatch(...args);
    },
  };
});

// This suite isolates lifecycle behavior from the workspace package build. Its
// paths are already POSIX relative, so an identity normalizer is sufficient.
vi.mock("@cfls/core-state", () => ({
  normalizePath: (path: string) => path,
}));

import { FolderWatcher, type FileChangeEvent } from "../src/watcher";

let dir: string;
let watcher: FolderWatcher | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cfls-watch-fallback-"));
  nativeWatchMock.mode = "native";
  nativeWatchMock.listeners.clear();
  nativeWatchMock.closeCalls = 0;
});

afterEach(() => {
  watcher?.stop();
  watcher = undefined;
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

function emitNativeWatcherError(): void {
  for (const listener of nativeWatchMock.listeners.get("error") ?? []) {
    listener();
  }
}

describe("FolderWatcher polling fallback", () => {
  it("reconciles changes when recursive fs.watch is unavailable", async () => {
    vi.useFakeTimers();
    nativeWatchMock.mode = "throw";
    watcher = new FolderWatcher({ folder: dir, pollIntervalMs: 20 });
    const events: FileChangeEvent[] = [];
    watcher.on("change", (event: FileChangeEvent) => events.push(event));

    watcher.start();
    watcher.start();
    expect(vi.getTimerCount()).toBe(1);

    writeFileSync(join(dir, "created.ts"), "export const created = true;");
    await vi.advanceTimersByTimeAsync(20);
    expect(events).toEqual([{ kind: "created", path: "created.ts" }]);

    watcher.stop();
    expect(vi.getTimerCount()).toBe(0);
    writeFileSync(join(dir, "after-stop.ts"), "not observed");
    await vi.advanceTimersByTimeAsync(40);
    expect(events).toEqual([{ kind: "created", path: "created.ts" }]);
  });

  it("switches to exactly one poller after a native watcher error", async () => {
    vi.useFakeTimers();
    nativeWatchMock.mode = "error";
    watcher = new FolderWatcher({ folder: dir, pollIntervalMs: 20 });
    const events: FileChangeEvent[] = [];
    watcher.on("change", (event: FileChangeEvent) => events.push(event));

    watcher.start();
    emitNativeWatcherError();
    emitNativeWatcherError();
    expect(nativeWatchMock.closeCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    writeFileSync(
      join(dir, "reconciled.ts"),
      "export const reconciled = true;",
    );
    await vi.advanceTimersByTimeAsync(20);
    expect(events).toEqual([{ kind: "created", path: "reconciled.ts" }]);

    watcher.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not revive a stopped native watcher through a late error", () => {
    vi.useFakeTimers();
    nativeWatchMock.mode = "error";
    watcher = new FolderWatcher({ folder: dir, pollIntervalMs: 20 });

    watcher.start();
    watcher.stop();
    expect(nativeWatchMock.closeCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);

    emitNativeWatcherError();
    expect(vi.getTimerCount()).toBe(0);
  });
});
