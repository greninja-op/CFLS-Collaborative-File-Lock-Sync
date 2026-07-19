/**
 * Shared test support for the agent integration tests: device identities,
 * signed invitations, and a fresh dev host over real WSS + in-memory SQLite.
 */

import { startHost, type RunningHost } from "@cfls/host";
import type { SessionId } from "@cfls/protocol";
import {
  generateDeviceKey,
  issueInvitation,
  type DeviceKey,
} from "@cfls/security";

/** Build a test SessionId. */
export function makeSession(overrides: Partial<SessionId> = {}): SessionId {
  return {
    repoId: "github.com/acme/app",
    teamId: "team-1",
    branch: "main",
    baseRevision: null,
    ...overrides,
  };
}

/** A device identity plus its member id for tests. */
export interface TestDevice {
  key: DeviceKey;
  memberId: string;
}

export function makeDevice(memberId: string): TestDevice {
  return { key: generateDeviceKey(), memberId };
}

/** Issue a base64-encoded Signed_Invitation for `device`, signed by `admin`. */
export function invitationFor(
  session: SessionId,
  admin: DeviceKey,
  device: TestDevice,
): string {
  const invitation = issueInvitation(
    {
      session,
      devicePublicKey: device.key.publicKey,
      memberId: device.memberId,
      issuerPublicKey: admin.publicKey,
    },
    admin.privateKey,
  );
  return Buffer.from(JSON.stringify(invitation), "utf8").toString("base64");
}

/** Start a fresh dev host with a self-signed cert on an ephemeral port. */
export async function startDevHost(): Promise<RunningHost> {
  return startHost(
    { hostUrl: "wss://127.0.0.1:0", tls: { devSelfSigned: true }, dbPath: ":memory:" },
    { expirySweepIntervalMs: 0 },
  );
}

/** Await a condition with polling, or throw after `timeoutMs`. */
export async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 4000,
  intervalMs = 25,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for condition.");
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
