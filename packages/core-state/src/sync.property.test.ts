/**
 * Property 8 — Reconnect synchronization converges.
 *
 * **Validates: Requirements 9.2, 9.3, 9.4, 9.5, 33.4**
 *
 * When a CoordinationAgent loses and later re-establishes its connection it must
 * converge its locally cached coordination state back to the CoordinationHost's
 * authoritative state **without missing or re-applying any event** (design §4.6):
 *
 *   1. On reconnect the agent requests synchronization identifying the highest
 *      Event_Revision it has applied (Req 9.2) — its `fromRevision`.
 *   2. The host returns the coordination events with a *greater* Event_Revision
 *      for the session (Req 9.3), or — when it can no longer serve incrementally
 *      (its retained log was compacted past `fromRevision`) — a full snapshot the
 *      agent replaces its cached state with (Req 9.5).
 *   3. The agent applies the response and its cached state converges to the
 *      authoritative state (Req 9.4/33.4), then clears staleness.
 *
 * Design "Correctness Properties" Property 8 states: *for any* authoritative
 * event log and *any* agent-held highest-applied revision, after applying the
 * host's incremental sync events (or a full snapshot when incremental is
 * unavailable), the agent's cached state equals the host's authoritative state.
 *
 * This single fast-check property (≥100 iterations) generates an arbitrary
 * authoritative log of coordination updates (soft_lock / presence / intent /
 * planned_file_creation `added`/`removed` events over a small pool of members
 * and paths, stamped with strictly increasing Event_Revisions), an arbitrary
 * revision the agent has already applied (it starts from the corresponding
 * prefix of the log), and an arbitrary host log-compaction watermark that
 * decides whether the reconnect is served incrementally or as a snapshot. It
 * then asserts that after `syncFrom` → `applySync`:
 *   - the reconnect is served incrementally exactly when the agent's
 *     `fromRevision` is at or above the compaction watermark, otherwise as a
 *     snapshot (Req 9.3, 9.5);
 *   - an incremental response carries **exactly** the events with a greater
 *     Event_Revision — a gap-free suffix `(fromRevision, N]` — so nothing is
 *     missed and nothing already applied is re-sent (Req 9.3);
 *   - the agent's converged cache equals the host's authoritative entry set and
 *     its highest-applied revision equals the host's highest (Req 9.4/33.4);
 *   - synchronization completing clears the staleness marker (Req 33.5); and
 *   - re-applying the very same response is a no-op — convergence is idempotent,
 *     so a re-delivered event is never applied twice.
 */

import { assertProperty, fc, propertyTag } from "@cfls/test-utils";
import { describe, expect, it } from "vitest";

import type {
  CoordinationUpdate,
  DeclaredIntent,
  Lock,
  MemberRef,
  Presence,
  SessionId,
  SessionStateSnapshot,
} from "@cfls/protocol";

import {
  AgentSyncCache,
  CoordinationEventLog,
  coordinationEntryKey,
  type SyncResponse,
} from "./sync";

const session: SessionId = {
  repoId: "github.com/acme/app",
  teamId: "team-1",
  branch: "main",
  baseRevision: "base-1",
};

const ACQUIRED_AT = "2024-01-01T00:00:00.000Z";

/** The coordination entry types a snapshot can project (design §4.3/§4.6). */
const entryTypeArb = fc.constantFrom<CoordinationUpdate["entryType"]>(
  "soft_lock",
  "presence",
  "intent",
  "planned_file_creation",
);

/**
 * One authoritative broadcast: an `added`/`removed` update over a small pool of
 * members and paths, so entries repeatedly contend, get replaced, and get
 * removed as the log grows.
 */
const opArb = fc.record({
  entryType: entryTypeArb,
  pathIdx: fc.nat({ max: 3 }),
  memberIdx: fc.nat({ max: 2 }),
  // Multiple declared tasks may touch one member/path; model the identity the
  // real host now includes in Coordination_Update metadata.
  intentIdx: fc.nat({ max: 2 }),
  op: fc.constantFrom<CoordinationUpdate["op"]>("added", "removed"),
});

const scenarioArb = fc.record({
  ops: fc.array(opArb, { minLength: 0, maxLength: 30 }),
  // Clamped to [0, N] below: the highest revision the agent had applied before
  // it disconnected (0 ⇒ it had applied nothing).
  fromRevisionRaw: fc.nat({ max: 32 }),
  // Clamped to [0, N] below: the host retention watermark. When it exceeds the
  // agent's fromRevision the host can no longer serve incrementally (Req 9.5).
  compactThroughRaw: fc.nat({ max: 32 }),
});

const member = (idx: number): MemberRef => ({
  memberId: `mem-${idx}`,
  deviceId: `dev-${idx}`,
});

const pathFor = (idx: number): string => `src/f${idx}.ts`;

/** A comparable projection of an active entry (identity + revision + payload). */
interface ComparableEntry {
  entryType: CoordinationUpdate["entryType"];
  op: CoordinationUpdate["op"];
  path: string | undefined;
  member: MemberRef;
  eventRevision: number;
  intent?: CoordinationUpdate["intent"];
}

/** Index a set of active entries by their canonical coordination-entry key. */
function indexByKey(
  entries: readonly CoordinationUpdate[],
): Record<string, ComparableEntry> {
  const out: Record<string, ComparableEntry> = {};
  for (const entry of entries) {
    out[coordinationEntryKey(entry)] = {
      entryType: entry.entryType,
      op: entry.op,
      path: entry.path,
      member: { ...entry.member },
      eventRevision: entry.eventRevision,
      ...(entry.intent !== undefined ? { intent: { ...entry.intent } } : {}),
    };
  }
  return out;
}

/**
 * The host's authoritative active-entry set: replay the whole ordered log from
 * empty, `added` installs (or replaces) an entry and `removed` deletes it. This
 * is the ground truth the agent must converge to, computed independently of the
 * module under test.
 */
function authoritativeState(
  log: readonly CoordinationUpdate[],
): Map<string, CoordinationUpdate> {
  const state = new Map<string, CoordinationUpdate>();
  for (const update of log) {
    const key = coordinationEntryKey(update);
    if (update.op === "removed") {
      state.delete(key);
    } else {
      state.set(key, update);
    }
  }
  return state;
}

/**
 * Build a full authoritative {@link SessionStateSnapshot} whose projection is
 * exactly `entries` — the inverse of {@link import("./sync").projectSnapshot}.
 * Each active entry maps to its own source entity so projecting the snapshot
 * reproduces the same entry set (this is the host's Req 9.5 fallback payload).
 */
function snapshotFor(
  entries: readonly CoordinationUpdate[],
  highestRevision: number,
): SessionStateSnapshot {
  const locks: Lock[] = [];
  const presence: Presence[] = [];
  const intents: DeclaredIntent[] = [];

  entries.forEach((entry, i) => {
    const path = entry.path ?? "";
    switch (entry.entryType) {
      case "soft_lock":
        locks.push({
          lockId: `lock-${i}`,
          scope: path,
          scopeKind: "file",
          mode: "soft",
          holder: { ...entry.member },
          branch: "main",
          eventRevision: entry.eventRevision,
          acquiredAt: ACQUIRED_AT,
          concurrent: false,
        });
        break;
      case "presence":
        presence.push({
          member: { ...entry.member },
          path,
          state: "started",
          eventRevision: entry.eventRevision,
        });
        break;
      case "intent":
        intents.push({
          intentId: entry.intent?.intentId ?? `intent-${i}`,
          owner: { ...entry.member },
          agentId: `agent-${i}`,
          modifyPaths: [path],
          createPaths: [],
          scopeKind: "file",
          branch: "main",
          description: entry.intent?.description ?? `edit ${i}`,
          eventRevision: entry.eventRevision,
        });
        break;
      case "planned_file_creation":
        intents.push({
          intentId: entry.intent?.intentId ?? `create-${i}`,
          owner: { ...entry.member },
          agentId: `agent-${i}`,
          modifyPaths: [],
          createPaths: [{ path }],
          scopeKind: "file",
          branch: "main",
          description: entry.intent?.description ?? `create ${i}`,
          eventRevision: entry.eventRevision,
        });
        break;
      default:
        break;
    }
  });

  return { session, locks, presence, intents, highestRevision };
}

describe(propertyTag(8, "reconnect synchronization converges"), () => {
  it("converges the agent's cache to authoritative state with no missed or re-applied events", () => {
    assertProperty(
      fc.property(
        scenarioArb,
        ({ ops, fromRevisionRaw, compactThroughRaw }) => {
          const n = ops.length;
          const fromRevision = Math.min(fromRevisionRaw, n);
          const compactThrough = Math.min(compactThroughRaw, n);

          // The authoritative log: each op becomes a broadcast update stamped
          // with a strictly increasing Event_Revision (1..N).
          const log: CoordinationUpdate[] = ops.map((op, i) => {
            const isIntent =
              op.entryType === "intent" ||
              op.entryType === "planned_file_creation";
            return {
              entryType: op.entryType,
              op: op.op,
              path: pathFor(op.pathIdx),
              member: member(op.memberIdx),
              eventRevision: i + 1,
              ...(isIntent
                ? {
                    intent: {
                      intentId: `${op.entryType}-${op.memberIdx}-${op.pathIdx}-${op.intentIdx}`,
                      description: `task ${op.intentIdx}`,
                    },
                  }
                : {}),
            };
          });

          // Ground-truth authoritative state and highest revision.
          const authoritative = authoritativeState(log);
          const highest = n; // revisions are the contiguous 1..N.

          // Host side: append the whole log, then compact its retained tail.
          const hostLog = new CoordinationEventLog();
          for (const update of log) {
            hostLog.append(session, update);
          }
          if (compactThrough > 0) {
            hostLog.compact(session, compactThrough);
          }

          // Agent side: it had applied the prefix (revision <= fromRevision)
          // before disconnecting, then marks its cache stale on the disconnect.
          const agent = new AgentSyncCache();
          agent.applyEvents(
            session,
            log.filter((u) => u.eventRevision <= fromRevision),
          );
          expect(agent.highestApplied(session)).toBe(fromRevision);
          agent.markStale();

          // Reconnect: request sync from the highest applied revision (Req 9.2).
          const snapshot = snapshotFor([...authoritative.values()], highest);
          const response: SyncResponse = hostLog.syncFrom(
            session,
            fromRevision,
            snapshot,
          );

          // The host serves incrementally exactly when the request is at or
          // above the retention watermark, otherwise a snapshot (Req 9.3/9.5).
          const servedIncrementally = fromRevision >= compactThrough;
          expect(response.kind).toBe(
            servedIncrementally ? "events" : "snapshot",
          );

          // An incremental response is exactly the gap-free suffix of events
          // with a greater revision: nothing missed, nothing re-sent (Req 9.3).
          if (response.kind === "events") {
            const expectedSuffix = log
              .filter((u) => u.eventRevision > fromRevision)
              .map((u) => u.eventRevision);
            expect(response.events.map((u) => u.eventRevision)).toEqual(
              expectedSuffix,
            );
          }

          // Apply the response, completing synchronization.
          agent.applySync(session, response);

          // Req 9.4 / 33.4: the converged cache equals the authoritative state.
          const expectedState = indexByKey([...authoritative.values()]);
          expect(indexByKey(agent.cachedEntries(session))).toEqual(
            expectedState,
          );

          // The agent's highest-applied revision matches the host's highest, so
          // a subsequent reconnect resumes from the right point.
          expect(agent.highestApplied(session)).toBe(highest);

          // Req 33.5: completing synchronization clears the staleness marker.
          expect(agent.isStale()).toBe(false);

          // Convergence is idempotent: re-delivering the same response applies
          // no event a second time and leaves the converged state unchanged.
          agent.applySync(session, response);
          expect(indexByKey(agent.cachedEntries(session))).toEqual(
            expectedState,
          );
          expect(agent.highestApplied(session)).toBe(highest);
        },
      ),
    );
  });
});
