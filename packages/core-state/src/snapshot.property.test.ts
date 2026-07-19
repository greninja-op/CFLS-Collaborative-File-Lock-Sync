/**
 * Property 7 — Registry persistence round-trip.
 *
 * **Validates: Requirements 1.5, 1.6, 9.5, 35.1**
 *
 * The CoordinationHost is the definitive authority for every
 * `Repository_Session` and must survive a restart: it persists coordination
 * metadata durably and, on restart, restores the last authoritative state and
 * resumes assigning Event_Revisions strictly greater than every previously
 * assigned one (Req 1.5, 1.6). The same authoritative-state snapshot is the
 * reconnect sync-snapshot fallback an agent replaces its cached state with
 * (Req 9.5) and the shape the agent persists to its local encrypted cache
 * (Req 35.1).
 *
 * Design "Correctness Properties" Property 7 states: *for any* authoritative
 * Lock_Registry and Intent_Registry state, restoring from its persisted form
 * produces an equivalent state, and the restored revision counter resumes above
 * the maximum persisted Event_Revision.
 *
 * This single fast-check property (≥100 iterations) generates an arbitrary
 * authoritative coordination state — an arbitrary set of members each acquiring
 * locks (soft / coordination-required / hard, contended or not), declaring
 * intents (with modify + Planned_File_Creation paths), and reporting presence,
 * all stamped by the shared monotonic {@link RevisionCounter} — then asserts a
 * serialize → restore → serialize round-trip is:
 *   - **state-preserving**: the snapshot produced from the restored registries
 *     is deeply equal to the snapshot produced from the source registries, so no
 *     lock, intent, presence entry, recomputed winner, or revision is lost or
 *     altered (Req 1.5, 9.5, 35.1);
 *   - **revision-safe**: the restored {@link RevisionCounter} resumes strictly
 *     above every persisted Event_Revision, so the next assignment can never
 *     collide with one issued before the restart (Req 1.6).
 */

import { assertProperty, fc, propertyTag } from "@cfls/test-utils";
import { describe, expect, it } from "vitest";

import type {
  RiskLevel,
  ScopeKind,
  SessionId,
  SessionStateSnapshot,
} from "@cfls/protocol";

import { IntentRegistry } from "./intents";
import { LockRegistry } from "./locks";
import { PresenceRegistry } from "./presence";
import { RevisionCounter } from "./revisions";
import {
  restoreSessionState,
  type SessionRegistries,
  serializeSessionState,
} from "./snapshot";

const session: SessionId = {
  repoId: "github.com/acme/app",
  teamId: "team-1",
  branch: "main",
  baseRevision: "base-1",
};

const ACQUIRED_AT = "2024-01-01T00:00:00.000Z";

/** A small pool of paths so lock scopes and create-paths sometimes contend. */
const pathArb = fc.constantFrom(
  "src/a.ts",
  "src/b.ts",
  "src/c.ts",
  "lib/x.ts",
  "docs/y.md",
);
const branchArb = fc.constantFrom("main", "dev");
const modeArb = fc.constantFrom<RiskLevel>("soft", "coordination-required", "hard");
// Restrict Intent_Scope to file/folder to keep generated authoritative state
// valid without depending on glob-pattern validity (covered elsewhere).
const scopeKindArb = fc.constantFrom<ScopeKind>("file", "folder");
const presenceStateArb = fc.constantFrom<"started" | "editing" | "stopped">(
  "started",
  "editing",
  "stopped",
);

const lockArb = fc.record({
  memberIdx: fc.nat({ max: 64 }),
  scope: pathArb,
  scopeKind: scopeKindArb,
  mode: modeArb,
  branch: branchArb,
});

const intentArb = fc.record({
  memberIdx: fc.nat({ max: 64 }),
  modify: fc.array(pathArb, { maxLength: 3 }),
  create: fc.array(pathArb, { maxLength: 3 }),
  scopeKind: scopeKindArb,
  branch: branchArb,
});

const presenceArb = fc.record({
  memberIdx: fc.nat({ max: 64 }),
  path: pathArb,
  state: presenceStateArb,
});

const scenarioArb = fc.record({
  memberCount: fc.integer({ min: 1, max: 4 }),
  locks: fc.array(lockArb, { maxLength: 10 }),
  intents: fc.array(intentArb, { maxLength: 8 }),
  presence: fc.array(presenceArb, { maxLength: 10 }),
});

function fresh(): SessionRegistries {
  return {
    locks: new LockRegistry(),
    intents: new IntentRegistry(),
    presence: new PresenceRegistry(),
    revisions: new RevisionCounter(),
  };
}

/** The maximum Event_Revision persisted anywhere in a snapshot. */
function maxPersisted(snapshot: SessionStateSnapshot): number {
  let max = snapshot.highestRevision;
  for (const lock of snapshot.locks) max = Math.max(max, lock.eventRevision);
  for (const entry of snapshot.presence) max = Math.max(max, entry.eventRevision);
  for (const intent of snapshot.intents) max = Math.max(max, intent.eventRevision);
  return max;
}

describe(propertyTag(7, "registry persistence round-trip"), () => {
  it("restore reproduces equivalent state and resumes revisions above the max persisted", () => {
    assertProperty(
      fc.property(scenarioArb, ({ memberCount, locks, intents, presence }) => {
        const members = Array.from({ length: memberCount }, (_, i) => ({
          memberId: `mem-${i}`,
          deviceId: `dev-${i}`,
        }));

        // Build an arbitrary authoritative Lock/Intent/Presence state, stamping
        // every event through the shared monotonic revision counter.
        const source = fresh();

        locks.forEach((lock, i) => {
          source.locks.acquire({
            session,
            lockId: `lock-${i}`,
            scope: lock.scope,
            scopeKind: lock.scopeKind,
            mode: lock.mode,
            holder: members[lock.memberIdx % memberCount]!,
            branch: lock.branch,
            eventRevision: source.revisions.next(session),
            acquiredAt: ACQUIRED_AT,
          });
        });

        intents.forEach((intent, i) => {
          // A Declared_Intent must list at least one modify or create path.
          const modify = intent.modify;
          const create = intent.create;
          const modifyPaths =
            modify.length === 0 && create.length === 0 ? ["src/a.ts"] : modify;
          source.intents.declare({
            session,
            intentId: `intent-${i}`,
            owner: members[intent.memberIdx % memberCount]!,
            agentId: `agent-${i}`,
            modifyPaths,
            createPaths: create,
            scopeKind: intent.scopeKind,
            branch: intent.branch,
            description: `edit ${i}`,
            eventRevision: source.revisions.next(session),
          });
        });

        presence.forEach((entry) => {
          source.presence.report({
            session,
            member: members[entry.memberIdx % memberCount]!,
            path: entry.path,
            state: entry.state,
            eventRevision: source.revisions.next(session),
          });
        });

        // Serialize the authoritative state, restore it into fresh registries
        // (simulating a host restart / sync-snapshot replacement), then
        // re-serialize the restored state.
        const persisted = serializeSessionState(session, source);
        const restored = fresh();
        restoreSessionState(persisted, restored);
        const roundTripped = serializeSessionState(session, restored);

        // 1. Round-trip is state-preserving: locks (with recomputed winners),
        //    intents, presence, and the highest revision all survive intact.
        expect(roundTripped).toEqual(persisted);

        // 2. The restored counter resumes strictly above every persisted
        //    Event_Revision, so no post-restart revision can collide (Req 1.6).
        const ceiling = maxPersisted(persisted);
        const nextRevision = restored.revisions.next(session);
        expect(nextRevision).toBe(ceiling + 1);
        for (const lock of persisted.locks) {
          expect(nextRevision).toBeGreaterThan(lock.eventRevision);
        }
        for (const intent of persisted.intents) {
          expect(nextRevision).toBeGreaterThan(intent.eventRevision);
        }
        for (const entry of persisted.presence) {
          expect(nextRevision).toBeGreaterThan(entry.eventRevision);
        }
      }),
    );
  });
});
