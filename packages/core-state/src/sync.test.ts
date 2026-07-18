/**
 * Unit tests for reconnect sync-from-revision convergence (Req 9.1–9.6, 33.4,
 * 33.5; design §4.6).
 *
 * Covers: the host serving an incremental suffix `> fromRevision`, snapshot
 * fallback when the log is compacted past the request, the agent applying events
 * without missing or re-applying, snapshot replacement, highest-applied tracking
 * (Req 9.1), staleness clearing on completion (Req 33.5), and the projection
 * bridge that makes incremental sync and snapshot fallback converge to one state.
 *
 * The universal convergence property is covered separately by the fast-check
 * property test in task 4.19 (Property 8).
 */

import { describe, expect, it } from "vitest";

import type {
  CoordinationUpdate,
  MemberRef,
  SessionId,
  SessionStateSnapshot,
} from "@cfls/protocol";

import { IntentRegistry } from "./intents";
import { LockRegistry } from "./locks";
import { PresenceRegistry } from "./presence";
import { RevisionCounter } from "./revisions";
import { serializeSessionState, type SessionRegistries } from "./snapshot";
import {
  AgentSyncCache,
  CoordinationEventLog,
  coordinationEntryKey,
  projectSnapshot,
} from "./sync";

const session: SessionId = {
  repoId: "github.com/acme/app",
  teamId: "team-1",
  branch: "main",
  baseRevision: "abc123",
};

const alice: MemberRef = { memberId: "u-alice", deviceId: "dev-a" };
const bob: MemberRef = { memberId: "u-bob", deviceId: "dev-b" };

function update(
  partial: Partial<CoordinationUpdate> & { eventRevision: number },
): CoordinationUpdate {
  return {
    entryType: "presence",
    op: "added",
    path: "src/a.ts",
    member: alice,
    ...partial,
  };
}

/** A canonical entry set for comparing caches regardless of order. */
function entrySet(entries: readonly CoordinationUpdate[]): Set<string> {
  return new Set(
    entries.map(
      (e) => `${coordinationEntryKey(e)}\u0000${e.op}\u0000${e.eventRevision}`,
    ),
  );
}

function emptySnapshot(): SessionStateSnapshot {
  return { session, locks: [], presence: [], intents: [], highestRevision: 0 };
}

describe("coordinationEntryKey", () => {
  it("collapses added/removed for the same entry to one key", () => {
    const added = update({ eventRevision: 1, op: "added" });
    const removed = update({ eventRevision: 2, op: "removed" });
    expect(coordinationEntryKey(added)).toBe(coordinationEntryKey(removed));
  });

  it("normalizes equivalent path spellings to one key (Req 10.3)", () => {
    const a = update({ eventRevision: 1, path: "src/a.ts" });
    const b = update({ eventRevision: 1, path: "./src/../src/a.ts" });
    expect(coordinationEntryKey(a)).toBe(coordinationEntryKey(b));
  });

  it("distinguishes entryType, path, and member", () => {
    const base = update({ eventRevision: 1 });
    expect(coordinationEntryKey(base)).not.toBe(
      coordinationEntryKey({ ...base, entryType: "soft_lock" }),
    );
    expect(coordinationEntryKey(base)).not.toBe(
      coordinationEntryKey({ ...base, path: "src/b.ts" }),
    );
    expect(coordinationEntryKey(base)).not.toBe(
      coordinationEntryKey({ ...base, member: bob }),
    );
  });
});

describe("CoordinationEventLog.append + syncFrom (Req 9.3)", () => {
  it("serves the incremental suffix strictly greater than fromRevision", () => {
    const log = new CoordinationEventLog();
    for (let rev = 1; rev <= 5; rev += 1) {
      log.append(session, update({ eventRevision: rev, path: `src/${rev}.ts` }));
    }

    const response = log.syncFrom(session, 3, emptySnapshot());

    expect(response.kind).toBe("events");
    if (response.kind !== "events") return;
    expect(response.events.map((e) => e.eventRevision)).toEqual([4, 5]);
  });

  it("returns an empty incremental set when already up to date", () => {
    const log = new CoordinationEventLog();
    log.append(session, update({ eventRevision: 1 }));
    log.append(session, update({ eventRevision: 2 }));

    const response = log.syncFrom(session, 2, emptySnapshot());
    expect(response.kind).toBe("events");
    if (response.kind !== "events") return;
    expect(response.events).toEqual([]);
  });

  it("serves everything from revision 0 on a fresh (never-synced) agent", () => {
    const log = new CoordinationEventLog();
    log.append(session, update({ eventRevision: 1 }));
    log.append(session, update({ eventRevision: 2 }));

    const response = log.syncFrom(session, 0, emptySnapshot());
    expect(response.kind).toBe("events");
    if (response.kind !== "events") return;
    expect(response.events.map((e) => e.eventRevision)).toEqual([1, 2]);
  });

  it("rejects non-monotonic or non-positive appended revisions", () => {
    const log = new CoordinationEventLog();
    log.append(session, update({ eventRevision: 5 }));
    expect(() => log.append(session, update({ eventRevision: 5 }))).toThrow();
    expect(() => log.append(session, update({ eventRevision: 4 }))).toThrow();
    expect(() =>
      log.append(session, update({ eventRevision: 0 })),
    ).toThrow();
  });

  it("does not alias appended updates (deep copy)", () => {
    const log = new CoordinationEventLog();
    const original = update({ eventRevision: 1 });
    log.append(session, original);
    original.member.memberId = "tampered";

    const response = log.syncFrom(session, 0, emptySnapshot());
    if (response.kind !== "events") throw new Error("expected events");
    expect(response.events[0]?.member.memberId).toBe("u-alice");
  });
});

describe("CoordinationEventLog snapshot fallback (Req 9.5)", () => {
  it("falls back to a snapshot when the request is below the compaction watermark", () => {
    const log = new CoordinationEventLog();
    for (let rev = 1; rev <= 5; rev += 1) {
      log.append(session, update({ eventRevision: rev }));
    }
    log.compact(session, 3); // discard revisions 1..3

    expect(log.canServeIncrementally(session, 2)).toBe(false);
    const snapshot: SessionStateSnapshot = { ...emptySnapshot(), highestRevision: 5 };
    const response = log.syncFrom(session, 2, snapshot);
    expect(response.kind).toBe("snapshot");
    if (response.kind !== "snapshot") return;
    expect(response.snapshot.highestRevision).toBe(5);
  });

  it("still serves incrementally at or above the compaction watermark", () => {
    const log = new CoordinationEventLog();
    for (let rev = 1; rev <= 5; rev += 1) {
      log.append(session, update({ eventRevision: rev }));
    }
    log.compact(session, 3);

    expect(log.canServeIncrementally(session, 3)).toBe(true);
    const response = log.syncFrom(session, 3, emptySnapshot());
    expect(response.kind).toBe("events");
    if (response.kind !== "events") return;
    expect(response.events.map((e) => e.eventRevision)).toEqual([4, 5]);
  });

  it("falls back to a snapshot for an invalid (negative) fromRevision", () => {
    const log = new CoordinationEventLog();
    log.append(session, update({ eventRevision: 1 }));
    const response = log.syncFrom(session, -1, emptySnapshot());
    expect(response.kind).toBe("snapshot");
  });
});

describe("AgentSyncCache incremental apply (Req 9.1, 9.3, 9.4)", () => {
  it("records the highest applied revision per session (Req 9.1)", () => {
    const cache = new AgentSyncCache();
    expect(cache.highestApplied(session)).toBe(0);
    cache.applyEvents(session, [
      update({ eventRevision: 1 }),
      update({ eventRevision: 2 }),
    ]);
    expect(cache.highestApplied(session)).toBe(2);
  });

  it("applies events in ascending revision order regardless of input order", () => {
    const cache = new AgentSyncCache();
    cache.applyEvents(session, [
      update({ eventRevision: 2, op: "removed" }),
      update({ eventRevision: 1, op: "added" }),
    ]);
    // Rev 1 adds, then rev 2 removes → entry gone, highest = 2.
    expect(cache.cachedEntries(session)).toEqual([]);
    expect(cache.highestApplied(session)).toBe(2);
  });

  it("never re-applies an event at or below the highest applied", () => {
    const cache = new AgentSyncCache();
    cache.applyEvents(session, [update({ eventRevision: 5, op: "added" })]);
    // A stale re-delivery of a lower revision must be ignored.
    cache.applyEvents(session, [update({ eventRevision: 5, op: "removed" })]);
    cache.applyEvents(session, [update({ eventRevision: 3, op: "removed" })]);
    expect(cache.cachedEntries(session)).toHaveLength(1);
    expect(cache.highestApplied(session)).toBe(5);
  });

  it("converges after a gap when the host serves a contiguous suffix", () => {
    const cache = new AgentSyncCache();
    cache.applyEvents(session, [
      update({ eventRevision: 1, path: "src/a.ts", op: "added" }),
      update({ eventRevision: 2, path: "src/b.ts", op: "added" }),
    ]);
    // Reconnect: host serves 3..4 (the suffix > highestApplied=2).
    cache.applyEvents(session, [
      update({ eventRevision: 3, path: "src/a.ts", op: "removed" }),
      update({ eventRevision: 4, path: "src/c.ts", op: "added" }),
    ]);
    const paths = cache
      .cachedEntries(session)
      .map((e) => e.path)
      .sort();
    expect(paths).toEqual(["src/b.ts", "src/c.ts"]);
    expect(cache.highestApplied(session)).toBe(4);
  });
});

describe("AgentSyncCache snapshot replacement (Req 9.5)", () => {
  it("replaces cached state wholesale and sets highestApplied", () => {
    const cache = new AgentSyncCache();
    cache.applyEvents(session, [
      update({ eventRevision: 1, path: "src/stale.ts", op: "added" }),
    ]);

    const snapshot: SessionStateSnapshot = {
      session,
      locks: [
        {
          lockId: "lk-1",
          scope: "src/api.ts",
          scopeKind: "file",
          mode: "soft",
          holder: bob,
          branch: "main",
          eventRevision: 7,
          acquiredAt: "2024-01-01T00:00:00Z",
          concurrent: false,
        },
      ],
      presence: [],
      intents: [],
      highestRevision: 9,
    };

    cache.applySnapshot(session, snapshot);
    const entries = cache.cachedEntries(session);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.entryType).toBe("soft_lock");
    expect(entries[0]?.path).toBe("src/api.ts");
    expect(entries[0]?.member.memberId).toBe("u-bob");
    expect(cache.highestApplied(session)).toBe(9);
  });
});

describe("staleness clearing on completion (Req 33.5, 6.6)", () => {
  it("clears staleness after applying incremental events", () => {
    const cache = new AgentSyncCache();
    cache.markStale();
    expect(cache.isStale()).toBe(true);
    cache.applySync(session, {
      kind: "events",
      events: [update({ eventRevision: 1 })],
    });
    expect(cache.isStale()).toBe(false);
  });

  it("clears staleness after applying a snapshot", () => {
    const cache = new AgentSyncCache();
    cache.markStale();
    cache.applySync(session, { kind: "snapshot", snapshot: emptySnapshot() });
    expect(cache.isStale()).toBe(false);
  });
});

describe("projectSnapshot bridges snapshot and incremental convergence", () => {
  it("projects locks, active presence, and intents; drops stopped presence", () => {
    const snapshot: SessionStateSnapshot = {
      session,
      locks: [
        {
          lockId: "lk-1",
          scope: "src/api.ts",
          scopeKind: "file",
          mode: "soft",
          holder: alice,
          branch: "main",
          eventRevision: 1,
          acquiredAt: "2024-01-01T00:00:00Z",
          concurrent: false,
        },
      ],
      presence: [
        { member: alice, path: "src/a.ts", state: "editing", eventRevision: 2 },
        { member: bob, path: "src/b.ts", state: "stopped", eventRevision: 3 },
      ],
      intents: [
        {
          intentId: "int-1",
          owner: bob,
          agentId: "agent-x",
          modifyPaths: ["src/db.ts"],
          createPaths: [{ path: "src/new.ts" }],
          scopeKind: "file",
          branch: "main",
          description: "refactor",
          eventRevision: 4,
        },
      ],
      highestRevision: 4,
    };

    const entries = projectSnapshot(snapshot);
    const kinds = entries.map((e) => `${e.entryType}:${e.path}`).sort();
    expect(kinds).toEqual([
      "intent:src/db.ts",
      "planned_file_creation:src/new.ts",
      "presence:src/a.ts",
      "soft_lock:src/api.ts",
    ]);
  });

  it("makes snapshot fallback and full incremental replay converge to the same state", () => {
    // Build authoritative state through the registries, then derive its snapshot.
    const regs: SessionRegistries = {
      locks: new LockRegistry(),
      intents: new IntentRegistry(),
      presence: new PresenceRegistry(),
      revisions: new RevisionCounter(),
    };
    const r1 = regs.revisions.next(session);
    regs.locks.acquire({
      session,
      lockId: "lk-1",
      scope: "src/api.ts",
      scopeKind: "file",
      mode: "soft",
      holder: alice,
      branch: "main",
      eventRevision: r1,
      acquiredAt: "2024-01-01T00:00:00Z",
    });
    const r2 = regs.revisions.next(session);
    regs.presence.report({
      session,
      member: bob,
      path: "src/b.ts",
      state: "editing",
      eventRevision: r2,
    });
    const snapshot = serializeSessionState(session, regs);

    // Agent A converges via a full incremental replay of the equivalent log.
    const log = new CoordinationEventLog();
    for (const entry of projectSnapshot(snapshot)) {
      log.append(session, entry);
    }
    const incrementalAgent = new AgentSyncCache();
    incrementalAgent.applySync(session, log.syncFrom(session, 0, snapshot));

    // Agent B converges via the snapshot fallback.
    const snapshotAgent = new AgentSyncCache();
    snapshotAgent.applySync(session, { kind: "snapshot", snapshot });

    expect(entrySet(incrementalAgent.cachedEntries(session))).toEqual(
      entrySet(snapshotAgent.cachedEntries(session)),
    );
  });
});

describe("session isolation", () => {
  it("tracks highestApplied and entries independently per session", () => {
    const other: SessionId = { ...session, branch: "feature" };
    const cache = new AgentSyncCache();
    cache.applyEvents(session, [update({ eventRevision: 3 })]);
    cache.applyEvents(other, [update({ eventRevision: 1 })]);
    expect(cache.highestApplied(session)).toBe(3);
    expect(cache.highestApplied(other)).toBe(1);
  });
});
