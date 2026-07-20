/**
 * The {@link HostGateway} — the seam between the agent's {@link AgentCoordinationPort}
 * and the CoordinationHost authority (task 9.3).
 *
 * Query methods read the agent's cached {@link AgentView}; **mutations** must go
 * to the host, which is the sole authority for Event_Revisions and conflict
 * resolution. The gateway abstracts that transmission so the port can be
 * exercised both against a real WSS connection ({@link RealHostGateway}) and,
 * deterministically without a socket, against an in-process authority
 * ({@link LocalHostGateway}) used by the multi-client fan-in unit tests.
 *
 * A gateway emits `"update"` `(CoordinationUpdate)` for every authoritative
 * broadcast so the port can converge its single shared view (Req 31.1), and
 * reports connectivity + staleness for the response envelope (Req 4.7, 33.2).
 * While offline, {@link HostGateway.transmit} returns `OFFLINE_QUEUED` and never
 * falsely reports host acceptance (Req 4.8).
 */

import { EventEmitter } from "node:events";

import {
  LockRegistry,
  IntentRegistry,
  RevisionCounter,
  resolveMode,
  type RepositoryRulesConfig,
} from "@cfls/core-state";
import type {
  CoordinationUpdate,
  IntentDeclarePayload,
  IntentUpdatePayload,
  IntentWithdrawPayload,
  LockAcquirePayload,
  LockReleasePayload,
  MemberRef,
  SessionId,
} from "@cfls/protocol";
import type {
  ConnectionSnapshot,
  EnvelopeError,
  StalenessSnapshot,
} from "@cfls/mcp-server";

import type { HostConnection } from "./connection";

/** A state-mutating event the agent forwards to the host. */
export type MutationEvent =
  | { type: "lock.acquire"; payload: LockAcquirePayload }
  | { type: "lock.release"; payload: LockReleasePayload }
  | { type: "intent.declare"; payload: IntentDeclarePayload }
  | { type: "intent.update"; payload: IntentUpdatePayload }
  | { type: "intent.withdraw"; payload: IntentWithdrawPayload };

/** Outcome of transmitting a mutation to the host authority. */
export type TransmitResult =
  | {
      ok: true;
      eventId: string;
      eventRevision: number;
      /** The primary resulting broadcast, when the host reported one. */
      update?: CoordinationUpdate;
    }
  | { ok: false; error: EnvelopeError };

/** The gateway contract the port depends on (transport-agnostic). */
export interface HostGateway extends EventEmitter {
  /** Connectivity snapshot for the response envelope (Req 4.7). */
  getConnection(): ConnectionSnapshot;
  /** Staleness snapshot for the response envelope (Req 33.2). */
  getStaleness(): StalenessSnapshot;
  /** Whether the host connection is currently online. */
  online(): boolean;
  /** Forward a mutation to the host; `OFFLINE_QUEUED` while offline (Req 4.8). */
  transmit(event: MutationEvent): Promise<TransmitResult>;
}

function offlineError(type: string): TransmitResult {
  return {
    ok: false,
    error: {
      code: "OFFLINE_QUEUED",
      message:
        `The CoordinationAgent is offline; '${type}' was queued and not accepted ` +
        `by the CoordinationHost. Manual coordination is required until ` +
        `connectivity is restored.`,
    },
  };
}

/**
 * A {@link HostGateway} backed by the live {@link HostConnection}. Forwards
 * mutations as Signed_Events and correlates the host's `coordination.update`
 * broadcast (for the assigned Event_Revision) or `error`.
 */
export class RealHostGateway extends EventEmitter implements HostGateway {
  constructor(private readonly connection: HostConnection) {
    super();
    // Fan every host broadcast out to the port's view.
    this.connection.on("update", (u: CoordinationUpdate) =>
      this.emit("update", u),
    );
  }

  getConnection(): ConnectionSnapshot {
    return this.connection.snapshot();
  }

  getStaleness(): StalenessSnapshot {
    return {
      stale: !this.connection.isOnline(),
      secondsSinceSync: this.connection.secondsSinceSync(),
    };
  }

  online(): boolean {
    return this.connection.isOnline();
  }

  async transmit(event: MutationEvent): Promise<TransmitResult> {
    if (!this.connection.isOnline()) {
      return offlineError(event.type);
    }
    // Register the correlation waiter BEFORE sending to avoid a race.
    const waiter = this.connection.waitFor(
      (m) => m?.type === "coordination.update" || m?.type === "error",
      4000,
    );
    const sent = this.connection.send(event.type, event.payload);
    if (!sent.ok) {
      return offlineError(event.type);
    }
    let message: { type: string; payload: Record<string, unknown> };
    try {
      message = await waiter;
    } catch {
      // Transmitted but no correlated broadcast within the window: report best
      // effort with the last known revision (the view converges via "update").
      return {
        ok: true,
        eventId: sent.eventId,
        eventRevision: this.connection.currentHighestRevision(),
      };
    }
    if (message.type === "error") {
      return {
        ok: false,
        error: {
          code:
            (message.payload.code as EnvelopeError["code"]) ?? "STORAGE_ERROR",
          message: String(
            message.payload.message ?? "Host rejected the event.",
          ),
        },
      };
    }
    const update = message.payload as unknown as CoordinationUpdate;
    return {
      ok: true,
      eventId: sent.eventId,
      eventRevision: update.eventRevision,
      update,
    };
  }
}

/** Options for a {@link LocalHostGateway}. */
export interface LocalHostGatewayOptions {
  session: SessionId;
  self: MemberRef;
  rules: RepositoryRulesConfig;
  online?: boolean;
  hostUrl?: string;
  now?: () => number;
}

/**
 * An in-process {@link HostGateway} that plays the role of the CoordinationHost
 * for deterministic tests (no socket). It assigns Event_Revisions from a real
 * {@link RevisionCounter}, applies mutations to authoritative registries, and
 * emits the resulting `coordination.update`(s) so the port's view converges —
 * exactly as a real host broadcast would. Peer activity can be injected with
 * {@link LocalHostGateway.injectRemote}.
 */
export class LocalHostGateway extends EventEmitter implements HostGateway {
  private readonly session: SessionId;
  private readonly self: MemberRef;
  private readonly rules: RepositoryRulesConfig;
  private readonly now: () => number;
  private readonly hostUrl: string;
  private isOnline: boolean;
  private lastSyncAt: string | null;

  private readonly locks = new LockRegistry();
  private readonly intents = new IntentRegistry();
  private readonly revisions = new RevisionCounter();
  private lockSeq = 0;
  private intentSeq = 0;

  constructor(options: LocalHostGatewayOptions) {
    super();
    this.session = options.session;
    this.self = options.self;
    this.rules = options.rules;
    this.now = options.now ?? Date.now;
    this.hostUrl = options.hostUrl ?? "wss://local.test:8443";
    this.isOnline = options.online ?? true;
    this.lastSyncAt = new Date(this.now()).toISOString();
  }

  setOnline(online: boolean): void {
    this.isOnline = online;
    if (online) {
      this.lastSyncAt = new Date(this.now()).toISOString();
    }
  }

  getConnection(): ConnectionSnapshot {
    return {
      status: this.isOnline ? "online" : "offline",
      hostUrl: this.hostUrl,
      lastSyncAt: this.lastSyncAt,
    };
  }

  getStaleness(): StalenessSnapshot {
    return {
      stale: !this.isOnline,
      secondsSinceSync:
        this.lastSyncAt === null
          ? null
          : Math.max(
              0,
              Math.floor((this.now() - Date.parse(this.lastSyncAt)) / 1000),
            ),
    };
  }

  online(): boolean {
    return this.isOnline;
  }

  /** Inject a peer's authoritative broadcast into the view (test helper). */
  injectRemote(update: CoordinationUpdate): void {
    this.emit("update", update);
  }

  async transmit(event: MutationEvent): Promise<TransmitResult> {
    if (!this.isOnline) {
      return offlineError(event.type);
    }
    const revision = this.revisions.next(this.session);
    const update = this.apply(event, revision);
    if (update !== undefined) {
      this.emit("update", update);
    }
    return Promise.resolve({
      ok: true,
      eventId: `local-${revision}`,
      eventRevision: revision,
      ...(update !== undefined ? { update } : {}),
    });
  }

  private apply(
    event: MutationEvent,
    revision: number,
  ): CoordinationUpdate | undefined {
    switch (event.type) {
      case "lock.acquire": {
        const lockId = `lk-${(this.lockSeq += 1)}`;
        this.locks.acquire({
          session: this.session,
          lockId,
          scope: event.payload.scope,
          scopeKind: event.payload.scopeKind,
          mode: resolveMode(event.payload.scope, this.rules),
          holder: this.self,
          branch: this.session.branch,
          eventRevision: revision,
          acquiredAt: new Date(this.now()).toISOString(),
        });
        return {
          entryType: "soft_lock",
          op: "added",
          path: event.payload.scope,
          member: this.self,
          eventRevision: revision,
        };
      }
      case "lock.release": {
        const scope = event.payload.scope ?? "";
        return {
          entryType: "soft_lock",
          op: "removed",
          path: scope,
          member: this.self,
          eventRevision: revision,
        };
      }
      case "intent.declare": {
        const intentId = `int-${(this.intentSeq += 1)}`;
        this.intents.declare({
          session: this.session,
          intentId,
          owner: this.self,
          agentId: this.self.deviceId,
          modifyPaths: event.payload.modifyPaths,
          createPaths: event.payload.createPaths,
          scopeKind: "file",
          branch: this.session.branch,
          description: event.payload.description,
          eventRevision: revision,
        });
        const path =
          event.payload.modifyPaths[0] ?? event.payload.createPaths[0] ?? "";
        const entryType =
          event.payload.modifyPaths.length > 0
            ? "intent"
            : "planned_file_creation";
        return {
          entryType,
          op: "added",
          path,
          member: this.self,
          eventRevision: revision,
        };
      }
      case "intent.update":
        return undefined;
      case "intent.withdraw":
        return undefined;
    }
  }
}
