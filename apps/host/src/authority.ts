/**
 * The CoordinationAuthority — the transport-independent heart of the host
 * (design §3.1). It assembles the pure `@cfls/core-state` engine, the
 * `@cfls/security` gates, and the durable {@link Store} into the definitive
 * coordination authority: authentication (Req 5), ingest with signature/replay/
 * idempotency/permission/data-minimization checks and monotonic Event_Revision
 * assignment (Req 7, 8, 29), broadcast projection scoped by session (Req 25),
 * sync-from-revision (Req 9), heartbeat/expiry (Req 26), and durable audit
 * (Req 28) with restart recovery (Req 1.5, 1.6).
 *
 * It is deliberately free of any WebSocket/TLS concerns so it can be unit- and
 * property-tested directly; {@link CoordinationServer} wires it to the network.
 */

import {
  CoordinationEventLog,
  ExpiryEngine,
  IngestGate,
  IntentRegistry,
  LockRegistry,
  PresenceRegistry,
  RevisionCounter,
  checkInboundMinimization,
  normalizePath,
  restoreSessionState,
  serializeSessionState,
  sessionKey,
  validateOverride,
  type ExpiryConfigInput,
  type SessionRegistries,
  type SyncResponse,
} from "@cfls/core-state";
import {
  MESSAGE_FORMAT_VERSION,
  type AuditRecord,
  type AuthHelloPayload,
  type CoordinationUpdate,
  type DependencyGraph,
  type DepDeltaPayload,
  type DepSnapshotPayload,
  type ErrorCode,
  type FileCreatedPayload,
  type IntentDeclarePayload,
  type IntentUpdatePayload,
  type IntentWithdrawPayload,
  type LockAcquirePayload,
  type LockOverridePayload,
  type LockReleasePayload,
  type MemberRef,
  type MembershipRegistryEntry,
  type PathDeletedPayload,
  type PathRenamedPayload,
  type PresenceReportPayload,
  type SessionId,
  type SignedEvent,
  type TypedEventEnvelope,
} from "@cfls/protocol";
import {
  admitDevice,
  canAuthenticate,
  deriveDeviceId,
  findMembershipEntry,
  revokeDevice,
  verifySignedEvent,
  createReplayGuard,
  type DevicePublicKey,
  type ReplayRecord,
  type SignedInvitation,
} from "@cfls/security";

import { generateChallenge, verifyChallenge } from "./challenge";
import type { Store } from "./store";

/** An authenticated connection principal produced by a successful handshake. */
export interface AuthPrincipal {
  session: SessionId;
  deviceId: string;
  memberId: string;
  devicePublicKey: DevicePublicKey;
}

/** Outcome of {@link CoordinationAuthority.prepareChallenge}. */
export type ChallengeResult =
  { ok: true; nonce: string } | { ok: false; code: ErrorCode; message: string };

/** Outcome of {@link CoordinationAuthority.finalizeHandshake}. */
export type HandshakeResult =
  | { ok: true; principal: AuthPrincipal; highestRevision: number }
  | { ok: false; code: ErrorCode; message: string };

/** Outcome of ingesting a single coordination event. */
export interface IngestOutcome {
  accepted: boolean;
  eventRevision?: number;
  duplicateOf?: number;
  error?: ErrorCode;
  reason?: string;
  /** Coordination updates to broadcast to the session's subscribers (Req 25). */
  broadcasts: CoordinationUpdate[];
}

/** Options for constructing a {@link CoordinationAuthority}. */
export interface AuthorityOptions {
  /** Heartbeat/expiry tuning (Req 26). */
  expiry?: ExpiryConfigInput;
}

/** The result of one `sync.request` (Req 9). */
export type SyncResult = SyncResponse;

/**
 * The definitive, transport-independent coordination authority (design §3.1).
 */
export class CoordinationAuthority {
  private readonly locks = new LockRegistry();
  private readonly intents = new IntentRegistry();
  private readonly presence = new PresenceRegistry();
  private readonly revisions: RevisionCounter;
  private readonly eventLog = new CoordinationEventLog();
  private readonly gate: IngestGate;
  private readonly expiry: ExpiryEngine;

  private readonly registries: SessionRegistries;

  /** `session_key` → in-memory Membership_Registry (mirror of the store). */
  private readonly membershipBySession = new Map<
    string,
    MembershipRegistryEntry[]
  >();
  /** `session_key` → authorized admin Device_Public_Keys (Req 5.5). */
  private readonly adminKeysBySession = new Map<string, Set<DevicePublicKey>>();
  /** `session_key` → SessionId (every session the authority knows about). */
  private readonly knownSessions = new Map<string, SessionId>();
  /** `session_key` → the latest metadata-only Dependency_Graph (Req 19, 20). */
  private readonly dependencyGraphs = new Map<string, DependencyGraph>();

  constructor(
    private readonly store: Store,
    options: AuthorityOptions = {},
  ) {
    this.revisions = new RevisionCounter();
    this.expiry = new ExpiryEngine(
      this.locks,
      this.intents,
      this.revisions,
      options.expiry,
    );
    this.registries = {
      locks: this.locks,
      intents: this.intents,
      presence: this.presence,
      revisions: this.revisions,
    };

    // Reseed the replay guard from persisted per-device counters (Req 7.5).
    const replaySeed: Array<readonly [string, ReplayRecord]> = this.store
      .deviceCounters()
      .map(({ deviceId, highestCounter }) => [
        deviceId,
        { highestCounter, usedNonces: new Set<string>() },
      ]);

    // Reseed the applied-Event_ID index so idempotency survives a restart (Req 7.4).
    const appliedSeed: Array<readonly [SessionId, string, number]> = [];
    for (const { session } of this.store.allSessions()) {
      for (const { eventId, eventRevision } of this.store.appliedEvents(
        session,
      )) {
        appliedSeed.push([session, eventId, eventRevision]);
      }
    }

    this.gate = new IngestGate({
      revisions: this.revisions,
      replayGuard: createReplayGuard(replaySeed),
      checkPermission: (envelope: TypedEventEnvelope) =>
        this.checkPermission(envelope),
      appliedEvents: appliedSeed,
    });

    this.recover();
  }

  // -------------------------------------------------------------------------
  // Session registration & membership
  // -------------------------------------------------------------------------

  /**
   * Register (or update) a session and its authorized admin keys (Req 5.5).
   * Admin keys are the devices permitted to issue `Signed_Invitation`s that
   * admit other devices to the session.
   */
  registerSession(
    session: SessionId,
    adminKeys: readonly DevicePublicKey[],
    options: { manualConfig?: boolean } = {},
  ): void {
    const key = sessionKey(session);
    this.knownSessions.set(key, session);
    this.adminKeysBySession.set(key, new Set(adminKeys));
    if (!this.membershipBySession.has(key)) {
      this.membershipBySession.set(key, this.store.membership(session));
    }
    this.store.upsertSession(session, options.manualConfig ?? false);
    this.store.setAdminKeys(session, adminKeys);
  }

  /** The current Membership_Registry for a session. */
  membership(session: SessionId): readonly MembershipRegistryEntry[] {
    return this.membershipBySession.get(sessionKey(session)) ?? [];
  }

  /** Revoke a device's key for a session (Req 5.6); rejects it thereafter. */
  revoke(session: SessionId, devicePublicKey: DevicePublicKey): void {
    const key = sessionKey(session);
    const registry = this.membershipBySession.get(key) ?? [];
    const next = revokeDevice(registry, devicePublicKey);
    this.membershipBySession.set(key, next);
    this.store.replaceMembership(session, next);
  }

  /** Every session the authority currently knows about. */
  sessions(): SessionId[] {
    return [...this.knownSessions.values()];
  }

  // -------------------------------------------------------------------------
  // Authentication handshake (Req 5.3–5.6; design §4.1)
  // -------------------------------------------------------------------------

  /**
   * Validate an `auth.hello` and, on success, issue a challenge nonce
   * (design §4.1 steps 2–3). Rejects an unsupported message-format version
   * (Req 7.6), an unregistered/forbidden session (Req 10.7), a device/session
   * mismatch or an invitation that does not chain to an authorized admin
   * (Req 5.4, 5.5), and a device whose key is already revoked (Req 5.6).
   */
  prepareChallenge(hello: AuthHelloPayload): ChallengeResult {
    if (hello.version !== MESSAGE_FORMAT_VERSION) {
      return {
        ok: false,
        code: "FORMAT_ERROR",
        message: `Unsupported message-format version ${hello.version}.`,
      };
    }

    const key = sessionKey(hello.session);
    const adminKeys = this.adminKeysBySession.get(key);
    if (adminKeys === undefined) {
      return {
        ok: false,
        code: "AUTH_SESSION_FORBIDDEN",
        message: "Unknown or unauthorized session.",
      };
    }

    const invitation = this.decodeInvitation(hello.signedInvitation);
    if (invitation === null) {
      return {
        ok: false,
        code: "AUTH_INVALID_DEVICE",
        message: "Malformed Signed_Invitation.",
      };
    }

    // The invitation must be for this session and this connecting device.
    if (sessionKey(invitation.claims.session) !== key) {
      return {
        ok: false,
        code: "AUTH_SESSION_FORBIDDEN",
        message: "Invitation is for a different session.",
      };
    }
    if (invitation.claims.devicePublicKey !== hello.devicePublicKey) {
      return {
        ok: false,
        code: "AUTH_INVALID_DEVICE",
        message: "Invitation does not match the connecting device.",
      };
    }

    // A device whose key is already revoked cannot re-admit itself (Req 5.6).
    const existing = findMembershipEntry(
      this.membershipBySession.get(key) ?? [],
      hello.devicePublicKey,
    );
    if (existing?.revoked === true) {
      return {
        ok: false,
        code: "AUTH_INVALID_DEVICE",
        message: "Device key has been revoked.",
      };
    }

    // Dry-run admission validates signature, expiry, and admin chaining.
    const admission = admitDevice(
      this.membershipBySession.get(key) ?? [],
      invitation,
      adminKeys,
    );
    if (!admission.admitted) {
      return { ok: false, code: admission.code, message: admission.reason };
    }

    return { ok: true, nonce: generateChallenge() };
  }

  /**
   * Complete the handshake: verify the `auth.response` signature over the
   * challenge nonce (Req 5.3), admit the device into the Membership_Registry,
   * and return the authenticated principal with the session's current highest
   * revision (design §4.1 steps 4–5).
   */
  finalizeHandshake(
    hello: AuthHelloPayload,
    nonce: string,
    responseSignature: string,
  ): HandshakeResult {
    // Re-validate the hello (cheap; guards against a tampered replay).
    const revalidated = this.prepareChallenge(hello);
    if (!revalidated.ok) {
      return {
        ok: false,
        code: revalidated.code,
        message: revalidated.message,
      };
    }

    if (!verifyChallenge(nonce, responseSignature, hello.devicePublicKey)) {
      return {
        ok: false,
        code: "AUTH_INVALID_DEVICE",
        message: "Challenge signature verification failed.",
      };
    }

    const key = sessionKey(hello.session);
    const invitation = this.decodeInvitation(hello.signedInvitation);
    const adminKeys = this.adminKeysBySession.get(key);
    if (invitation === null || adminKeys === undefined) {
      return {
        ok: false,
        code: "AUTH_INVALID_DEVICE",
        message: "Invitation is no longer valid.",
      };
    }

    const admission = admitDevice(
      this.membershipBySession.get(key) ?? [],
      invitation,
      adminKeys,
    );
    if (!admission.admitted) {
      return { ok: false, code: admission.code, message: admission.reason };
    }

    this.membershipBySession.set(key, admission.registry);
    this.store.replaceMembership(hello.session, admission.registry);
    this.knownSessions.set(key, hello.session);

    const principal: AuthPrincipal = {
      session: hello.session,
      deviceId: deriveDeviceId(hello.devicePublicKey),
      memberId: admission.entry.memberId,
      devicePublicKey: hello.devicePublicKey,
    };

    return {
      ok: true,
      principal,
      highestRevision: this.revisions.highest(hello.session),
    };
  }

  // -------------------------------------------------------------------------
  // Ingest pipeline (Req 7, 8, 29; design §4.4, §4.5)
  // -------------------------------------------------------------------------

  /**
   * Ingest a Signed_Event from an authenticated principal (design §4.4):
   * data-minimization rejection (Req 29.5), session/device authorization
   * (Req 10.7), signature verification against a non-revoked key (Req 7.2, 7.3),
   * then the shared ingest gate (schema/version, permission, idempotency, replay,
   * monotonic revision assignment — Req 7.4–7.7, 8.1). On acceptance the state
   * mutation runs exactly once and the produced broadcasts are logged, persisted,
   * and returned for session-scoped delivery.
   */
  ingest(principal: AuthPrincipal, input: SignedEvent): IngestOutcome {
    const envelope = input.envelope;

    // Session scoping: the event must target the connection's session (Req 10.7).
    if (sessionKey(envelope.session) !== sessionKey(principal.session)) {
      return {
        accepted: false,
        error: "AUTH_SESSION_FORBIDDEN",
        reason: "Event session does not match the authenticated session.",
        broadcasts: [],
      };
    }
    if (envelope.deviceId !== principal.deviceId) {
      return {
        accepted: false,
        error: "AUTH_INVALID_DEVICE",
        reason: "Event device does not match the authenticated device.",
        broadcasts: [],
      };
    }

    // Data-minimization rejection before any state change (Req 29.5).
    const minimization = checkInboundMinimization(envelope);
    if (!minimization.ok) {
      return {
        accepted: false,
        error: minimization.error.code,
        reason: minimization.error.message,
        broadcasts: [],
      };
    }

    // Signature verification against a non-revoked, admitted key (Req 7.2, 7.3, 5.6).
    const key = sessionKey(principal.session);
    if (
      !canAuthenticate(
        this.membershipBySession.get(key) ?? [],
        principal.devicePublicKey,
      )
    ) {
      return {
        accepted: false,
        error: "AUTH_INVALID_DEVICE",
        reason: "Device is not admitted or has been revoked.",
        broadcasts: [],
      };
    }
    if (!verifySignedEvent(input, principal.devicePublicKey)) {
      return {
        accepted: false,
        error: "AUTH_INVALID_DEVICE",
        reason: "Event signature verification failed.",
        broadcasts: [],
      };
    }

    const member: MemberRef = {
      memberId: principal.memberId,
      deviceId: principal.deviceId,
    };
    const broadcasts: CoordinationUpdate[] = [];
    const audits: AuditRecord[] = [];
    let applyError: { code: ErrorCode; reason: string } | undefined;

    const result = this.gate.ingest(
      input,
      (env: TypedEventEnvelope, eventRevision: number) => {
        const applied = this.apply(
          env,
          eventRevision,
          member,
          broadcasts,
          audits,
        );
        if (applied !== undefined) {
          applyError = applied;
        }
      },
    );

    if (!result.accepted) {
      return {
        accepted: false,
        ...(result.error !== undefined ? { error: result.error } : {}),
        ...(result.reason !== undefined ? { reason: result.reason } : {}),
        broadcasts: [],
      };
    }

    // Idempotent duplicate: nothing re-applied, return the original revision.
    if (result.duplicateOf !== undefined) {
      return {
        accepted: true,
        ...(result.eventRevision !== undefined
          ? { eventRevision: result.eventRevision }
          : {}),
        duplicateOf: result.duplicateOf,
        broadcasts: [],
      };
    }

    const eventRevision = result.eventRevision as number;

    // Persist the event and applied-id index for durability/idempotency (Req 1.5, 7.4).
    this.store.appendEvent({
      session: envelope.session,
      eventRevision,
      eventId: envelope.eventId,
      type: envelope.type,
      deviceId: envelope.deviceId,
      payloadJson: JSON.stringify(envelope.payload),
      replayCounter: envelope.replay.counter,
      createdAt: new Date().toISOString(),
    });
    this.store.recordApplied(envelope.session, envelope.eventId, eventRevision);

    // A business-rule rejection surfaced from the applier (e.g. NOT_LOCK_HOLDER):
    // the revision is consumed (idempotent) but no state changed — return error.
    if (applyError !== undefined) {
      return {
        accepted: false,
        error: applyError.code,
        reason: applyError.reason,
        eventRevision,
        broadcasts: [],
      };
    }

    // Log broadcasts for sync, persist audits + snapshot for restart recovery.
    for (const update of broadcasts) {
      this.eventLog.append(envelope.session, update);
    }
    for (const audit of audits) {
      this.store.appendAudit({ ...audit, session: envelope.session });
    }
    this.persistSnapshot(envelope.session);

    return { accepted: true, eventRevision, broadcasts };
  }

  /**
   * Apply a validated, accepted event to authoritative state, collecting the
   * broadcasts and audit records it produces. Returns an error descriptor when
   * the event is rejected by a business rule (holder/owner checks, override
   * reason, intent validation); otherwise `undefined`.
   */
  private apply(
    envelope: TypedEventEnvelope,
    eventRevision: number,
    member: MemberRef,
    broadcasts: CoordinationUpdate[],
    audits: AuditRecord[],
  ): { code: ErrorCode; reason: string } | undefined {
    const session = envelope.session;
    const now = new Date().toISOString();

    switch (envelope.type) {
      case "presence.report": {
        const payload = envelope.payload as PresenceReportPayload;
        this.presence.report({
          session,
          member,
          path: payload.path,
          state: payload.state,
          eventRevision,
        });
        broadcasts.push({
          entryType: "presence",
          op: payload.state === "stopped" ? "removed" : "added",
          path: payload.path,
          member,
          eventRevision,
        });
        return undefined;
      }

      case "lock.acquire": {
        const payload = envelope.payload as LockAcquirePayload;
        const outcome = this.locks.acquire({
          session,
          lockId: envelope.eventId,
          scope: payload.scope,
          scopeKind: payload.scopeKind,
          mode: payload.mode,
          holder: member,
          branch: session.branch,
          eventRevision,
          acquiredAt: now,
        });
        // Broadcast the CURRENT WINNER of the scope, not merely the acquiring
        // member: a contended (losing) acquisition must inform every agent —
        // and the losing acquirer itself — that the earlier-revision holder
        // still owns the lock (Req 8.2, 8.4, 12.4). The event's own (monotonic)
        // Event_Revision is used so the coordination event log stays strictly
        // ordered while the winner's identity converges everywhere. For an
        // uncontended acquisition the winner is the acquirer, so this is a
        // no-op change.
        broadcasts.push({
          entryType: "soft_lock",
          op: "added",
          path: outcome.winner.scope,
          member: outcome.winner.holder,
          eventRevision,
        });
        return undefined;
      }

      case "lock.override": {
        const payload = envelope.payload as LockOverridePayload;
        const validated = validateOverride({
          session,
          member,
          scope: payload.scope,
          overrideReason: payload.overrideReason,
          eventRevision,
          at: now,
        });
        if (!validated.ok) {
          return {
            code: validated.code,
            reason:
              "Coordination-required override requires an Override_Reason.",
          };
        }
        this.locks.acquire({
          session,
          lockId: envelope.eventId,
          scope: payload.scope,
          scopeKind: payload.scopeKind,
          mode: payload.mode,
          holder: member,
          branch: session.branch,
          eventRevision,
          acquiredAt: now,
        });
        audits.push(validated.audit);
        broadcasts.push({
          entryType: "soft_lock",
          op: "added",
          path: payload.scope,
          member,
          eventRevision,
        });
        return undefined;
      }

      case "lock.release": {
        const payload = envelope.payload as LockReleasePayload;
        const release = this.locks.release({
          session,
          requester: member,
          branch: session.branch,
          ...(payload.lockId !== undefined ? { lockId: payload.lockId } : {}),
          ...(payload.scope !== undefined ? { scope: payload.scope } : {}),
        });
        if (!release.ok) {
          return {
            code: release.code,
            reason:
              release.code === "NOT_LOCK_HOLDER"
                ? "Release attempted by a non-holder."
                : "No active lock to release.",
          };
        }
        // Each coordination change gets its own strictly-increasing revision so
        // the event log and every agent cache apply both the release and any
        // promotion (a shared revision would drop the second — Req 8.1, 9.3).
        const allocate = this.revisionAllocator(session, eventRevision);
        broadcasts.push({
          entryType: "soft_lock",
          op: "removed",
          path: release.released.scope,
          member: release.released.holder,
          eventRevision: allocate(),
        });
        if (release.promoted !== undefined) {
          broadcasts.push({
            entryType: "soft_lock",
            op: "added",
            path: release.promoted.scope,
            member: release.promoted.holder,
            eventRevision: allocate(),
          });
        }
        return undefined;
      }

      case "intent.declare": {
        const payload = envelope.payload as IntentDeclarePayload;
        const declared = this.intents.declare({
          session,
          intentId: envelope.eventId,
          owner: member,
          agentId: member.deviceId,
          modifyPaths: payload.modifyPaths,
          createPaths: payload.createPaths,
          scopeKind: "file",
          branch: session.branch,
          description: payload.description,
          eventRevision,
        });
        if (!declared.ok) {
          return {
            code: declared.code,
            reason:
              declared.errors?.join("; ") ?? "Intent declaration rejected.",
          };
        }
        this.emitIntentBroadcasts(
          declared.intent,
          "added",
          this.revisionAllocator(session, eventRevision),
          broadcasts,
        );
        audits.push({
          member,
          action: "create",
          targetScope:
            declared.intent.modifyPaths[0] ??
            declared.intent.createPaths[0]?.path ??
            "",
          eventRevision,
          time: now,
        });
        return undefined;
      }

      case "intent.update": {
        const payload = envelope.payload as IntentUpdatePayload;
        const updated = this.intents.update({
          session,
          intentId: payload.intentId,
          requester: member,
          modifyPaths: payload.modifyPaths,
          createPaths: payload.createPaths,
          description: payload.description,
          eventRevision,
        });
        if (!updated.ok) {
          return {
            code: updated.code,
            reason: updated.errors?.join("; ") ?? "Intent update rejected.",
          };
        }
        this.emitIntentBroadcasts(
          updated.intent,
          "added",
          this.revisionAllocator(session, eventRevision),
          broadcasts,
        );
        audits.push({
          member,
          action: "update",
          targetScope: updated.intent.modifyPaths[0] ?? "",
          eventRevision,
          time: now,
        });
        return undefined;
      }

      case "intent.withdraw": {
        const payload = envelope.payload as IntentWithdrawPayload;
        const withdrawn = this.intents.withdraw({
          session,
          intentId: payload.intentId,
          requester: member,
        });
        if (!withdrawn.ok) {
          return {
            code: withdrawn.code,
            reason: "Intent withdrawal rejected.",
          };
        }
        this.emitIntentBroadcasts(
          withdrawn.removed,
          "removed",
          this.revisionAllocator(session, eventRevision),
          broadcasts,
        );
        audits.push({
          member,
          action: "withdraw",
          targetScope: withdrawn.removed.modifyPaths[0] ?? "",
          eventRevision,
          time: now,
        });
        return undefined;
      }

      case "path.renamed": {
        const payload = envelope.payload as PathRenamedPayload;
        this.applyRename(
          session,
          member,
          payload,
          eventRevision,
          broadcasts,
          audits,
          now,
        );
        return undefined;
      }

      case "path.deleted": {
        const payload = envelope.payload as PathDeletedPayload;
        this.applyDelete(
          session,
          member,
          payload,
          eventRevision,
          broadcasts,
          audits,
          now,
        );
        return undefined;
      }

      case "file.created": {
        const payload = envelope.payload as FileCreatedPayload;
        const allocate = this.revisionAllocator(session, eventRevision);
        // Record the created path as tracked and retire any matching
        // Planned_File_Creation on active intents (Req 17.2, 17.3).
        const reconciled = this.intents.reconcileCreation(
          session,
          payload.path,
        );
        for (const intent of reconciled.removedFrom) {
          broadcasts.push({
            entryType: "planned_file_creation",
            op: "removed",
            path: payload.path,
            member: intent.owner,
            eventRevision: allocate(),
          });
        }
        return undefined;
      }

      case "intent.progress": {
        // Progress is advisory: it reports how far an owned intent has gotten
        // but changes none of the authoritative coordination state (locks,
        // intents, presence) and is not part of the broadcast
        // Coordination_Update model (design §4.3). The event is still validated,
        // persisted, and revision-stamped by the ingest pipeline; there is
        // simply nothing to mutate or broadcast here.
        return undefined;
      }

      case "dep.snapshot": {
        const payload = envelope.payload as DepSnapshotPayload;
        // Persist the metadata-only Dependency_Graph so the host holds it for the
        // session identity (Req 19.3, 20.1). Distribution to other agents is
        // handled by the server layer via the returned graph.
        this.store.upsertDependencyGraph(session, payload.graph);
        this.dependencyGraphs.set(sessionKey(session), payload.graph);
        return undefined;
      }

      case "dep.delta": {
        const payload = envelope.payload as DepDeltaPayload;
        this.applyDependencyDelta(session, payload);
        return undefined;
      }

      default:
        // Any remaining message types are accepted and recorded but produce no
        // coordination broadcast.
        return undefined;
    }
  }

  /**
   * Apply a confirmed rename/move (Req 30.2, 30.3): transfer the sender's lock
   * from the old path to the new one, follow the file in every intent that
   * referenced it, and emit the corresponding removal/addition broadcasts so
   * every agent's cached view converges.
   */
  private applyRename(
    session: SessionId,
    member: MemberRef,
    payload: PathRenamedPayload,
    eventRevision: number,
    broadcasts: CoordinationUpdate[],
    audits: AuditRecord[],
    now: string,
  ): void {
    const allocate = this.revisionAllocator(session, eventRevision);

    // Classify how each affected member's intent referenced the old path BEFORE
    // the rewrite, so removals carry the correct entry type.
    const before = this.intents.allIntents(session);
    const fromKey = normalizePath(payload.fromPath);

    const moved = this.locks.transferPath({
      session,
      member,
      fromScope: payload.fromPath,
      toScope: payload.toPath,
      scopeKind: "file",
      branch: session.branch,
      eventRevision,
    });
    if (moved !== undefined) {
      broadcasts.push({
        entryType: "soft_lock",
        op: "removed",
        path: payload.fromPath,
        member: moved.holder,
        eventRevision: allocate(),
      });
      broadcasts.push({
        entryType: "soft_lock",
        op: "added",
        path: payload.toPath,
        member: moved.holder,
        eventRevision: allocate(),
      });
    }

    const updated = this.intents.renamePath(
      session,
      payload.fromPath,
      payload.toPath,
    );
    for (const intent of updated) {
      const priorForOwner = before.find((i) => i.intentId === intent.intentId);
      const wasModify =
        priorForOwner?.modifyPaths.some((p) => normalizePath(p) === fromKey) ??
        false;
      const entryType = wasModify ? "intent" : "planned_file_creation";
      broadcasts.push({
        entryType,
        op: "removed",
        path: payload.fromPath,
        member: intent.owner,
        eventRevision: allocate(),
      });
      broadcasts.push({
        entryType,
        op: "added",
        path: payload.toPath,
        member: intent.owner,
        eventRevision: allocate(),
      });
    }

    audits.push({
      member,
      action: "update",
      targetScope: payload.toPath,
      eventRevision,
      time: now,
    });
  }

  /**
   * Apply a confirmed deletion (Req 30.5): release the deleting member's lock on
   * the path and remove the path from that member's intents, emitting removals.
   */
  private applyDelete(
    session: SessionId,
    member: MemberRef,
    payload: PathDeletedPayload,
    eventRevision: number,
    broadcasts: CoordinationUpdate[],
    audits: AuditRecord[],
    now: string,
  ): void {
    const allocate = this.revisionAllocator(session, eventRevision);
    const key = normalizePath(payload.path);

    // Classify the member's references to the path before removing them.
    const owned = this.intents
      .allIntents(session)
      .filter((i) => i.owner.memberId === member.memberId);
    const wasModify = owned.some((i) =>
      i.modifyPaths.some((p) => normalizePath(p) === key),
    );
    const wasCreate = owned.some((i) =>
      i.createPaths.some((c) => normalizePath(c.path) === key),
    );

    const released = this.locks.releaseOnDelete(
      session,
      payload.path,
      "file",
      session.branch,
      member,
    );
    if (released !== undefined) {
      broadcasts.push({
        entryType: "soft_lock",
        op: "removed",
        path: payload.path,
        member: released.holder,
        eventRevision: allocate(),
      });
    }

    const updated = this.intents.deletePathForMember(
      session,
      payload.path,
      member,
    );
    if (updated.length > 0) {
      if (wasModify) {
        broadcasts.push({
          entryType: "intent",
          op: "removed",
          path: payload.path,
          member,
          eventRevision: allocate(),
        });
      }
      if (wasCreate) {
        broadcasts.push({
          entryType: "planned_file_creation",
          op: "removed",
          path: payload.path,
          member,
          eventRevision: allocate(),
        });
      }
    }

    audits.push({
      member,
      action: "update",
      targetScope: payload.path,
      eventRevision,
      time: now,
    });
  }

  /**
   * Apply an incremental Dependency_Graph delta (Req 19.4) on top of the stored
   * graph for the session, persisting the merged result. When no graph is stored
   * yet the delta is applied to an empty graph for this session's identity.
   */
  private applyDependencyDelta(
    session: SessionId,
    delta: DepDeltaPayload,
  ): void {
    const key = sessionKey(session);
    const current =
      this.dependencyGraphs.get(key) ??
      this.store.getDependencyGraph(session) ??
      this.emptyGraph(session);

    const modules = current.modules.map((m) => ({
      sourceFile: m.sourceFile,
      edges: [...m.edges],
    }));
    const moduleByFile = new Map(modules.map((m) => [m.sourceFile, m]));
    const edgeKey = (from: string, to: string, kind: string): string =>
      `${from}\u0000${to}\u0000${kind}`;

    for (const change of delta.changedEdges) {
      let mod = moduleByFile.get(change.from);
      if (mod === undefined) {
        mod = { sourceFile: change.from, edges: [] };
        moduleByFile.set(change.from, mod);
        modules.push(mod);
      }
      if (change.op === "remove") {
        mod.edges = mod.edges.filter(
          (e) =>
            edgeKey(e.from, e.to, e.kind) !==
            edgeKey(change.from, change.to, change.kind),
        );
      } else {
        const exists = mod.edges.some(
          (e) =>
            edgeKey(e.from, e.to, e.kind) ===
            edgeKey(change.from, change.to, change.kind),
        );
        if (!exists) {
          mod.edges.push({
            from: change.from,
            to: change.to,
            kind: change.kind,
            confidence: change.confidence,
          });
        }
      }
    }

    // Apply contract changes: an empty fingerprint signals removal.
    const contracts = new Map(current.contracts.map((c) => [c.id, c]));
    for (const contract of delta.changedContracts) {
      if (contract.fingerprint === "") {
        contracts.delete(contract.id);
      } else {
        contracts.set(contract.id, contract);
      }
    }

    const merged: DependencyGraph = {
      snapshot: {
        sessionId: session,
        graphVersion: current.snapshot.graphVersion + 1,
        analyzerVersion: current.snapshot.analyzerVersion,
      },
      packages: current.packages,
      modules: modules.filter((m) => m.edges.length > 0),
      contracts: [...contracts.values()],
    };
    this.store.upsertDependencyGraph(session, merged);
    this.dependencyGraphs.set(key, merged);
  }

  /** An empty Dependency_Graph for a session (delta baseline). */
  private emptyGraph(session: SessionId): DependencyGraph {
    return {
      snapshot: {
        sessionId: session,
        graphVersion: 0,
        analyzerVersion: "unknown",
      },
      packages: [],
      modules: [],
      contracts: [],
    };
  }

  /**
   * A per-event revision allocator. A single ingested event can produce several
   * coordination broadcasts (e.g. a multi-path Declared_Intent, or a release
   * plus a promotion); each must carry its OWN strictly-increasing
   * Event_Revision so the coordination event log stays strictly ordered
   * (Req 8.1) and every agent cache applies all of them rather than dropping
   * later broadcasts that share a revision (Req 9.3). The first allocation
   * reuses the event's assigned revision; subsequent ones advance the shared
   * monotonic counter.
   */
  private revisionAllocator(session: SessionId, first: number): () => number {
    let used = false;
    return () => {
      if (!used) {
        used = true;
        return first;
      }
      return this.revisions.next(session);
    };
  }

  private emitIntentBroadcasts(
    intent: {
      modifyPaths: readonly string[];
      createPaths: readonly { path: string }[];
      owner: MemberRef;
    },
    op: "added" | "removed",
    allocate: () => number,
    broadcasts: CoordinationUpdate[],
  ): void {
    for (const path of intent.modifyPaths) {
      broadcasts.push({
        entryType: "intent",
        op,
        path,
        member: intent.owner,
        eventRevision: allocate(),
      });
    }
    for (const creation of intent.createPaths) {
      broadcasts.push({
        entryType: "planned_file_creation",
        op,
        path: creation.path,
        member: intent.owner,
        eventRevision: allocate(),
      });
    }
  }

  /** The gate's permission predicate: the sender must be admitted (Req 7.7, 10.7). */
  private checkPermission(
    envelope: TypedEventEnvelope,
  ):
    | { permitted: true }
    | { permitted: false; code: ErrorCode; reason: string } {
    const registry = this.membershipBySession.get(sessionKey(envelope.session));
    if (registry === undefined) {
      return {
        permitted: false,
        code: "AUTH_SESSION_FORBIDDEN",
        reason: "Unknown session.",
      };
    }
    const entry = registry.find(
      (e) => deriveDeviceId(e.devicePublicKey) === envelope.deviceId,
    );
    if (entry === undefined || entry.revoked || !entry.invitationValid) {
      return {
        permitted: false,
        code: "AUTH_NOT_AUTHORIZED",
        reason: "Sender is not authorized for this session.",
      };
    }
    return { permitted: true };
  }

  // -------------------------------------------------------------------------
  // Sync-from-revision (Req 9; design §4.6)
  // -------------------------------------------------------------------------

  /**
   * Serve a reconnect sync request (Req 9.2–9.5): incremental `sync.events` for
   * revisions `> fromRevision`, or a full `sync.snapshot` fallback built from the
   * authoritative registries when incremental service is impossible.
   */
  syncFrom(session: SessionId, fromRevision: number): SyncResult {
    const snapshot = serializeSessionState(session, this.registries);
    return this.eventLog.syncFrom(session, fromRevision, snapshot);
  }

  /** The current authoritative snapshot for a session (Req 9.5). */
  snapshot(session: SessionId) {
    return serializeSessionState(session, this.registries);
  }

  /**
   * The latest metadata-only Dependency_Graph the host holds for a session, or
   * `null` when none has been uploaded (Req 19, 20). The server sends this to a
   * connecting agent so every client shares the same graph for risk analysis.
   */
  dependencyGraph(session: SessionId): DependencyGraph | null {
    const cached = this.dependencyGraphs.get(sessionKey(session));
    if (cached !== undefined) {
      return cached;
    }
    const stored = this.store.getDependencyGraph(session);
    if (stored !== null) {
      this.dependencyGraphs.set(sessionKey(session), stored);
    }
    return stored;
  }

  // -------------------------------------------------------------------------
  // Heartbeats & expiry (Req 26; design §5.2)
  // -------------------------------------------------------------------------

  /** Record a device heartbeat (Req 26.2). */
  recordHeartbeat(
    session: SessionId,
    deviceId: string,
    atMs: number = Date.now(),
  ): void {
    this.expiry.recordHeartbeat(session, deviceId, atMs);
  }

  /**
   * Run the stale lock/intent expiry sweep and the soft-lock max-age sweep for a
   * session (Req 26.3–26.5), logging and persisting the resulting removals.
   * Returns the removal updates to broadcast.
   */
  sweepExpiry(
    session: SessionId,
    nowMs: number = Date.now(),
  ): CoordinationUpdate[] {
    const removals = [
      ...this.expiry.sweep(session, nowMs).removals,
      ...this.expiry.expireStaleSoftLocks(session, nowMs).removals,
    ];
    if (removals.length === 0) {
      return [];
    }
    for (const update of removals) {
      this.eventLog.append(session, update);
      this.store.appendAudit({
        session,
        member: update.member,
        action: "expire",
        targetScope: update.path ?? "",
        eventRevision: update.eventRevision,
        time: new Date().toISOString(),
      });
    }
    this.persistSnapshot(session);
    return removals;
  }

  // -------------------------------------------------------------------------
  // Diagnostics (Req 27)
  // -------------------------------------------------------------------------

  /** The audit trail for a session (Req 28). */
  auditRecords(session: SessionId): AuditRecord[] {
    return this.store.auditRecords(session);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Persist the authoritative snapshot for restart recovery (Req 1.5, 1.6). */
  private persistSnapshot(session: SessionId): void {
    this.store.saveSnapshot(serializeSessionState(session, this.registries));
  }

  /** Restore authoritative state and revision counters on startup (Req 1.5, 1.6). */
  private recover(): void {
    for (const { session, highestRevision } of this.store.allSessions()) {
      const key = sessionKey(session);
      this.knownSessions.set(key, session);
      this.membershipBySession.set(key, this.store.membership(session));
      this.adminKeysBySession.set(key, new Set(this.store.adminKeys(session)));

      const snapshot = this.store.loadSnapshot(session);
      if (snapshot !== null) {
        restoreSessionState(snapshot, this.registries);
      }
      // Resume the counter above the persisted highest revision (Req 1.6). The
      // applied-Event_ID index was reseeded into the gate at construction.
      this.revisions.resume(session, highestRevision);
    }
  }

  private decodeInvitation(encoded: string): SignedInvitation | null {
    try {
      const json = Buffer.from(encoded, "base64").toString("utf8");
      const parsed = JSON.parse(json) as SignedInvitation;
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof parsed.signature !== "string" ||
        typeof parsed.claims !== "object"
      ) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }
}
