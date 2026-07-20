/**
 * Property 14 — Stale locks and intents expire deterministically.
 *
 * **Validates: Requirements 26.3**
 *
 * The CoordinationHost tracks a per-device liveness signal (the Heartbeat) and
 * automatically releases the coordination state of any device that stops
 * confirming its liveness. For any coordination state and clock, the expiry
 * sweep run by {@link ExpiryEngine.sweep} MUST release **exactly** the locks and
 * Declared_Intents held by devices whose most recent Heartbeat is older than the
 * `Lock_Expiry_Interval` (i.e. `now - lastSeen > lockExpiryIntervalMs`), and
 * leave every other holder's locks and intents intact (design §5.2, §13.4).
 *
 * This single fast-check property (≥100 iterations) generates an arbitrary
 * coordination state — a set of devices each optionally holding a lock and/or a
 * Declared_Intent, each with either no recorded heartbeat or a heartbeat at an
 * arbitrary offset before an arbitrary clock reading — under an arbitrary valid
 * expiry configuration, then asserts that after the sweep:
 *   - the swept device set is exactly the devices whose recorded heartbeat is
 *     strictly older than the Lock_Expiry_Interval (devices with no recorded
 *     heartbeat are never swept);
 *   - the released locks/intents are exactly those held by those stale devices;
 *   - every lock/intent held by a non-stale device (or a device with no
 *     heartbeat) remains untouched;
 *   - each release is reported as a `removed` update attributed to a stale
 *     device and carries a unique, freshly assigned Event_Revision.
 */

import { assertProperty, fc, propertyTag } from "@cfls/test-utils";
import { describe, expect, it } from "vitest";

import type { RiskLevel, SessionId } from "@cfls/protocol";

import { ExpiryEngine } from "./expiry";
import { IntentRegistry } from "./intents";
import { LockRegistry } from "./locks";
import { RevisionCounter } from "./revisions";

const session: SessionId = {
  repoId: "github.com/acme/app",
  teamId: "team-1",
  branch: "main",
  baseRevision: "base-1",
};

const ACQUIRED_AT = "2024-01-01T00:00:00.000Z";

/** One generated device: its liveness and what coordination state it holds. */
const deviceArb = fc.record({
  /** When false, the device has no recorded heartbeat and is never swept. */
  hasHeartbeat: fc.boolean(),
  /** How long before `now` the device's most recent heartbeat was received. */
  offsetMs: fc.integer({ min: 0, max: 400_000 }),
  hasLock: fc.boolean(),
  lockMode: fc.constantFrom<RiskLevel>("soft", "coordination-required", "hard"),
  hasIntent: fc.boolean(),
});

const scenarioArb = fc.record({
  // A valid expiry config: Lock_Expiry_Interval = heartbeat × multiple (≥3×).
  heartbeatIntervalMs: fc.constantFrom(5_000, 15_000, 30_000, 60_000),
  lockMultiple: fc.integer({ min: 3, max: 6 }),
  // An arbitrary clock reading, kept well above the max heartbeat offset so
  // every generated heartbeat time is a valid non-negative epoch reading.
  now: fc.integer({ min: 1_000_000, max: 5_000_000 }),
  devices: fc.array(deviceArb, { minLength: 0, maxLength: 8 }),
});

describe(
  propertyTag(14, "stale locks and intents expire deterministically"),
  () => {
    it("releases exactly the locks/intents of devices whose heartbeat is older than the Lock_Expiry_Interval", () => {
      assertProperty(
        fc.property(
          scenarioArb,
          ({ heartbeatIntervalMs, lockMultiple, now, devices }) => {
            const lockExpiryIntervalMs = heartbeatIntervalMs * lockMultiple;

            const locks = new LockRegistry("case-sensitive");
            const intents = new IntentRegistry("case-sensitive");
            const revisions = new RevisionCounter();
            const engine = new ExpiryEngine(locks, intents, revisions, {
              heartbeatIntervalMs,
              lockExpiryIntervalMs,
            });

            // Each device gets a unique identity + unique scopes so no two claims
            // ever contend — expiry is then purely about heartbeat staleness.
            const staleDeviceIds = new Set<string>();
            const expectedRemovedLockScopes = new Set<string>();
            const expectedSurvivingLockScopes = new Set<string>();
            const expectedRemovedIntentIds = new Set<string>();
            const expectedSurvivingIntentIds = new Set<string>();

            devices.forEach((device, i) => {
              const deviceId = `dev-${i}`;
              const holder = { memberId: `mem-${i}`, deviceId };
              const lockScope = `src/lock-${i}.ts`;
              const intentId = `intent-${i}`;

              // A device is stale only when it HAS a recorded heartbeat that is
              // strictly older than the Lock_Expiry_Interval.
              const isStale =
                device.hasHeartbeat && device.offsetMs > lockExpiryIntervalMs;
              if (device.hasHeartbeat) {
                engine.recordHeartbeat(
                  session,
                  deviceId,
                  now - device.offsetMs,
                );
              }
              if (isStale) {
                staleDeviceIds.add(deviceId);
              }

              if (device.hasLock) {
                locks.acquire({
                  session,
                  lockId: `lock-${i}`,
                  scope: lockScope,
                  scopeKind: "file",
                  mode: device.lockMode,
                  holder,
                  branch: "main",
                  eventRevision: revisions.next(session),
                  acquiredAt: ACQUIRED_AT,
                });
                (isStale
                  ? expectedRemovedLockScopes
                  : expectedSurvivingLockScopes
                ).add(lockScope);
              }

              if (device.hasIntent) {
                intents.declare({
                  session,
                  intentId,
                  owner: holder,
                  agentId: `agent-${i}`,
                  modifyPaths: [`src/intent-${i}.ts`],
                  createPaths: [],
                  scopeKind: "file",
                  branch: "main",
                  description: `edit ${i}`,
                  eventRevision: revisions.next(session),
                });
                (isStale
                  ? expectedRemovedIntentIds
                  : expectedSurvivingIntentIds
                ).add(intentId);
              }
            });

            const revBefore = revisions.highest(session);
            const result = engine.sweep(session, now);

            // 1. Exactly the stale devices are swept.
            expect(new Set(result.expiredDevices)).toEqual(staleDeviceIds);

            // 2. Surviving locks/intents are exactly those held by non-stale devices.
            const survivingLockScopes = new Set(
              locks.allLocks(session).map((l) => l.scope),
            );
            const survivingIntentIds = new Set(
              intents.allIntents(session).map((intent) => intent.intentId),
            );
            expect(survivingLockScopes).toEqual(expectedSurvivingLockScopes);
            expect(survivingIntentIds).toEqual(expectedSurvivingIntentIds);

            // 3. No stale holder's lock/intent survives.
            for (const scope of expectedRemovedLockScopes) {
              expect(survivingLockScopes.has(scope)).toBe(false);
            }
            for (const intentId of expectedRemovedIntentIds) {
              expect(survivingIntentIds.has(intentId)).toBe(false);
            }

            // 4. The removals are exactly the released locks + intents, each a
            //    `removed` update attributed to a stale device.
            const removedLockScopes = new Set(
              result.removals
                .filter((u) => u.entryType === "soft_lock")
                .map((u) => u.path),
            );
            const removedIntentMembers = result.removals.filter(
              (u) => u.entryType === "intent",
            );
            expect(removedLockScopes).toEqual(expectedRemovedLockScopes);
            expect(removedIntentMembers).toHaveLength(
              expectedRemovedIntentIds.size,
            );
            expect(result.removals).toHaveLength(
              expectedRemovedLockScopes.size + expectedRemovedIntentIds.size,
            );
            for (const update of result.removals) {
              expect(update.op).toBe("removed");
              expect(staleDeviceIds.has(update.member.deviceId)).toBe(true);
              expect(update.eventRevision).toBeGreaterThan(revBefore);
            }

            // 5. Every assigned removal revision is unique.
            const revs = result.removals.map((u) => u.eventRevision);
            expect(new Set(revs).size).toBe(revs.length);
          },
        ),
      );
    });
  },
);
