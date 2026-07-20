/**
 * Unit tests for the SQLite DAO and revision-counter atomicity (task 8.10;
 * Req 8.1, 1.8, 7.4). Covers atomic `nextRevision`, `hasAppliedEventId`, and
 * typed `STORAGE_ERROR` codes.
 */

import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import type { SessionId } from "@cfls/protocol";

import { SqliteStore, StoreError, type PersistedEvent } from "./store";

const sessionA: SessionId = {
  repoId: "github.com/acme/app",
  teamId: "team-1",
  branch: "main",
  baseRevision: null,
};
const sessionB: SessionId = {
  repoId: "github.com/acme/app",
  teamId: "team-1",
  branch: "feature-x",
  baseRevision: "abc123",
};

function makeEvent(overrides: Partial<PersistedEvent> = {}): PersistedEvent {
  return {
    session: sessionA,
    eventRevision: 1,
    eventId: "evt-1",
    type: "lock.acquire",
    deviceId: "dev-1",
    payloadJson: "{}",
    replayCounter: 1,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("SqliteStore.nextRevision (Req 8.1)", () => {
  let store: SqliteStore;
  afterEach(() => store?.close());

  it("assigns strictly increasing, unique, gap-free revisions per session", () => {
    store = new SqliteStore(":memory:");
    const assigned: number[] = [];
    for (let i = 0; i < 200; i++) {
      assigned.push(store.nextRevision(sessionA));
    }
    // Strictly increasing 1..200 with no duplicates or gaps.
    expect(assigned).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
    expect(new Set(assigned).size).toBe(assigned.length);
    expect(store.currentRevision(sessionA)).toBe(200);
  });

  it("keeps revision counters independent per session", () => {
    store = new SqliteStore(":memory:");
    expect(store.nextRevision(sessionA)).toBe(1);
    expect(store.nextRevision(sessionA)).toBe(2);
    // A different session starts from its own 1.
    expect(store.nextRevision(sessionB)).toBe(1);
    expect(store.nextRevision(sessionA)).toBe(3);
    expect(store.nextRevision(sessionB)).toBe(2);
    expect(store.currentRevision(sessionA)).toBe(3);
    expect(store.currentRevision(sessionB)).toBe(2);
  });

  it("returns 0 for a session that has never assigned a revision", () => {
    store = new SqliteStore(":memory:");
    expect(store.currentRevision(sessionA)).toBe(0);
  });
});

describe("SqliteStore.hasAppliedEventId (Req 7.4)", () => {
  let store: SqliteStore;
  afterEach(() => store?.close());

  it("returns null before an event is applied and the revision afterwards", () => {
    store = new SqliteStore(":memory:");
    expect(store.hasAppliedEventId(sessionA, "evt-1")).toBeNull();
    store.recordApplied(sessionA, "evt-1", 7);
    expect(store.hasAppliedEventId(sessionA, "evt-1")).toBe(7);
  });

  it("is idempotent: re-recording the same event id keeps the first revision", () => {
    store = new SqliteStore(":memory:");
    store.recordApplied(sessionA, "evt-1", 7);
    store.recordApplied(sessionA, "evt-1", 99);
    expect(store.hasAppliedEventId(sessionA, "evt-1")).toBe(7);
  });

  it("scopes applied ids by session", () => {
    store = new SqliteStore(":memory:");
    store.recordApplied(sessionA, "evt-1", 7);
    expect(store.hasAppliedEventId(sessionB, "evt-1")).toBeNull();
  });
});

describe("SqliteStore typed errors (STORAGE_ERROR)", () => {
  let store: SqliteStore | undefined;
  afterEach(() => {
    try {
      store?.close();
    } catch {
      // Ignore: some tests intentionally never open a valid database.
    }
    store = undefined;
  });

  it("throws a StoreError when appending a duplicate revision", () => {
    store = new SqliteStore(":memory:");
    store.appendEvent(makeEvent({ eventRevision: 1, eventId: "evt-1" }));
    try {
      store.appendEvent(makeEvent({ eventRevision: 1, eventId: "evt-2" }));
      expect.unreachable("expected a StoreError");
    } catch (error) {
      expect(error).toBeInstanceOf(StoreError);
      expect((error as StoreError).code).toBe("STORAGE_ERROR");
    }
  });

  it("throws a StoreError when appending a duplicate event id", () => {
    store = new SqliteStore(":memory:");
    store.appendEvent(makeEvent({ eventRevision: 1, eventId: "evt-1" }));
    try {
      store.appendEvent(makeEvent({ eventRevision: 2, eventId: "evt-1" }));
      expect.unreachable("expected a StoreError");
    } catch (error) {
      expect(error).toBeInstanceOf(StoreError);
      expect((error as StoreError).code).toBe("STORAGE_ERROR");
    }
  });

  it("surfaces a StoreError with code STORAGE_ERROR when the DB cannot open", () => {
    // Opening an existing directory as a database file cannot succeed.
    try {
      new SqliteStore(tmpdir());
      expect.unreachable("expected a StoreError");
    } catch (error) {
      expect(error).toBeInstanceOf(StoreError);
      expect((error as StoreError).code).toBe("STORAGE_ERROR");
    }
  });
});

describe("SqliteStore.eventsSince (Req 9.3)", () => {
  let store: SqliteStore;
  afterEach(() => store?.close());

  it("returns only events after the requested revision, ascending", () => {
    store = new SqliteStore(":memory:");
    for (let rev = 1; rev <= 5; rev++) {
      store.appendEvent(
        makeEvent({ eventRevision: rev, eventId: `evt-${rev}` }),
      );
    }
    const since = store.eventsSince(sessionA, 2);
    expect(since.map((e) => e.eventRevision)).toEqual([3, 4, 5]);
  });
});
