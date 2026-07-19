/**
 * The host persistence DAO and its SQLite implementation (Req 1.5, 1.6, 1.8;
 * design §5.2).
 *
 * All durable host state sits behind the {@link Store} interface so the MVP
 * SQLite backing can be replaced by PostgreSQL later **without behavior change**
 * (Req 1.8, design §5.2 / §"Design Decisions"). The interface is deliberately
 * narrow — atomic revision assignment, append-only event/audit logs, membership,
 * dependency graphs, and an authoritative-state snapshot for restart recovery —
 * and every method is metadata-only (no source content, no absolute paths;
 * Req 28.3, 29).
 *
 * {@link SqliteStore} implements it over Node's built-in `node:sqlite`
 * (`DatabaseSync`), which needs zero native build and no external service —
 * ideal for the laptop-hosted MVP. Its operations are synchronous; because
 * Node's event loop is single-threaded, a single SQL statement (e.g. the
 * `INSERT … ON CONFLICT … RETURNING` used by {@link Store.nextRevision}) is an
 * atomic read-modify-write, giving the monotonic, gap-free revision guarantee
 * (Req 8.1) the design requires.
 */

import { DatabaseSync } from "node:sqlite";

import { sessionKey } from "@cfls/core-state";
import type {
  AuditRecord,
  DependencyGraph,
  MembershipRegistryEntry,
  SessionId,
  SessionStateSnapshot,
} from "@cfls/protocol";

/** A durably-persisted coordination event (design §5.2 `events`). */
export interface PersistedEvent {
  session: SessionId;
  eventRevision: number;
  eventId: string;
  type: string;
  deviceId: string;
  /** Canonical JSON of the event payload (metadata only). */
  payloadJson: string;
  replayCounter: number;
  createdAt: string;
}

/** A persisted session header (design §5.2 `sessions`). */
export interface PersistedSession {
  session: SessionId;
  highestRevision: number;
  manualConfig: boolean;
}

/**
 * A typed persistence failure (design §11.1 `STORAGE_ERROR`). The host maps this
 * to a `STORAGE_ERROR` protocol error and rejects without changing authoritative
 * state.
 */
export class StoreError extends Error {
  readonly code = "STORAGE_ERROR" as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StoreError";
  }
}

/**
 * The host persistence DAO (Req 1.8; design §5.2). SQLite implements it for the
 * MVP; PostgreSQL can implement the same contract later unchanged.
 */
export interface Store {
  /**
   * Atomically assign and return the next monotonic Event_Revision for a session
   * (Req 8.1). The first call for a session returns `1`; each subsequent call
   * returns exactly one greater. Implemented as a single atomic statement so
   * revisions are unique and strictly ordered even under rapid succession.
   */
  nextRevision(session: SessionId): number;
  /** The highest revision assigned so far for a session (`0` if none). */
  currentRevision(session: SessionId): number;
  /** Ensure a session header row exists (idempotent). */
  upsertSession(session: SessionId, manualConfig?: boolean): void;
  /** Every persisted session header — used to seed counters on restart (Req 1.6). */
  allSessions(): PersistedSession[];

  /** Durably append an accepted event (Req 1.5). */
  appendEvent(event: PersistedEvent): void;
  /** Persisted events with `eventRevision > fromRevision`, ascending (Req 9.3). */
  eventsSince(session: SessionId, fromRevision: number): PersistedEvent[];
  /**
   * The Event_Revision an `eventId` was applied at for a session, or `null` if
   * it has not been applied (Req 7.4 idempotency).
   */
  hasAppliedEventId(session: SessionId, eventId: string): number | null;
  /** Record that an `eventId` was applied at a revision (Req 7.4). */
  recordApplied(session: SessionId, eventId: string, eventRevision: number): void;
  /** Every applied `(eventId, revision)` for a session — to reseed the gate on restart. */
  appliedEvents(session: SessionId): { eventId: string; eventRevision: number }[];
  /**
   * The highest replay counter persisted per device across all sessions — used
   * to reseed the replay guard on restart so a pre-restart counter cannot be
   * replayed (Req 7.5).
   */
  deviceCounters(): { deviceId: string; highestCounter: number }[];

  /** Append a durable Audit_Record (Req 28) — no source content. */
  appendAudit(record: AuditRecord & { session: SessionId }): void;
  /** All audit records for a session, ascending by id. */
  auditRecords(session: SessionId): AuditRecord[];

  /** The Membership_Registry view for a session (Req 5.2). */
  membership(session: SessionId): MembershipRegistryEntry[];
  /** Replace the Membership_Registry for a session. */
  replaceMembership(session: SessionId, entries: readonly MembershipRegistryEntry[]): void;
  /** The authorized admin Device_Public_Keys for a session (Req 5.5). */
  adminKeys(session: SessionId): string[];
  /** Replace the authorized admin keys for a session. */
  setAdminKeys(session: SessionId, keys: readonly string[]): void;

  /** Persist the authoritative-state snapshot for restart recovery (Req 1.5, 1.6). */
  saveSnapshot(snapshot: SessionStateSnapshot): void;
  /** Load the persisted authoritative-state snapshot for a session, or `null`. */
  loadSnapshot(session: SessionId): SessionStateSnapshot | null;

  /** Upsert the metadata-only Dependency_Graph for a session (Req 20.1). */
  upsertDependencyGraph(session: SessionId, graph: DependencyGraph): void;
  /** Load the Dependency_Graph for a session, or `null`. */
  getDependencyGraph(session: SessionId): DependencyGraph | null;

  /** Close the underlying database. */
  close(): void;
}

/** The DDL for the SQLite schema (design §5.2; metadata-only). */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  session_key TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL, team_id TEXT NOT NULL, branch TEXT NOT NULL,
  base_revision TEXT,
  highest_revision INTEGER NOT NULL DEFAULT 0,
  manual_config INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events (
  session_key TEXT NOT NULL, event_revision INTEGER NOT NULL, event_id TEXT NOT NULL,
  type TEXT NOT NULL, device_id TEXT NOT NULL, payload_json TEXT NOT NULL,
  replay_counter INTEGER NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (session_key, event_revision),
  UNIQUE (session_key, event_id)
);
CREATE TABLE IF NOT EXISTS applied_events (
  session_key TEXT NOT NULL, event_id TEXT NOT NULL, event_revision INTEGER NOT NULL,
  PRIMARY KEY (session_key, event_id)
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_key TEXT NOT NULL,
  member_id TEXT NOT NULL, device_id TEXT NOT NULL, action TEXT NOT NULL,
  target_scope TEXT NOT NULL, override_reason TEXT, event_revision INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS membership (
  session_key TEXT NOT NULL, device_pubkey TEXT NOT NULL, member_id TEXT NOT NULL,
  invitation_valid INTEGER NOT NULL, revoked INTEGER NOT NULL, rotated_from TEXT,
  PRIMARY KEY (session_key, device_pubkey)
);
CREATE TABLE IF NOT EXISTS admin_keys (
  session_key TEXT NOT NULL, device_pubkey TEXT NOT NULL,
  PRIMARY KEY (session_key, device_pubkey)
);
CREATE TABLE IF NOT EXISTS snapshots (
  session_key TEXT PRIMARY KEY, snapshot_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dependency_graphs (
  session_key TEXT PRIMARY KEY, graph_version INTEGER NOT NULL,
  analyzer_version TEXT NOT NULL, graph_json TEXT NOT NULL
);
`;

/**
 * SQLite-backed {@link Store} over `node:sqlite` (Req 1.8; design §5.2).
 * Synchronous, zero-dependency, and file-durable (or `:memory:` for tests).
 */
export class SqliteStore implements Store {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    try {
      this.db = new DatabaseSync(dbPath);
      this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
      this.db.exec(SCHEMA);
    } catch (error) {
      throw new StoreError(`Failed to open SQLite store at ${dbPath}.`, {
        cause: error,
      });
    }
  }

  nextRevision(session: SessionId): number {
    const key = sessionKey(session);
    try {
      const row = this.db
        .prepare(
          `INSERT INTO sessions (session_key, repo_id, team_id, branch, base_revision, highest_revision, manual_config)
           VALUES (?, ?, ?, ?, ?, 1, 0)
           ON CONFLICT(session_key) DO UPDATE SET highest_revision = highest_revision + 1
           RETURNING highest_revision`,
        )
        .get(
          key,
          session.repoId,
          session.teamId,
          session.branch,
          session.baseRevision,
        ) as { highest_revision: number } | undefined;
      if (row === undefined) {
        throw new StoreError("nextRevision returned no row.");
      }
      return row.highest_revision;
    } catch (error) {
      if (error instanceof StoreError) throw error;
      throw new StoreError("Failed to assign the next Event_Revision.", {
        cause: error,
      });
    }
  }

  currentRevision(session: SessionId): number {
    const row = this.db
      .prepare(`SELECT highest_revision FROM sessions WHERE session_key = ?`)
      .get(sessionKey(session)) as { highest_revision: number } | undefined;
    return row?.highest_revision ?? 0;
  }

  upsertSession(session: SessionId, manualConfig = false): void {
    this.db
      .prepare(
        `INSERT INTO sessions (session_key, repo_id, team_id, branch, base_revision, highest_revision, manual_config)
         VALUES (?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT(session_key) DO UPDATE SET manual_config = excluded.manual_config`,
      )
      .run(
        sessionKey(session),
        session.repoId,
        session.teamId,
        session.branch,
        session.baseRevision,
        manualConfig ? 1 : 0,
      );
  }

  allSessions(): PersistedSession[] {
    const rows = this.db
      .prepare(
        `SELECT repo_id, team_id, branch, base_revision, highest_revision, manual_config FROM sessions`,
      )
      .all() as Array<{
      repo_id: string;
      team_id: string;
      branch: string;
      base_revision: string | null;
      highest_revision: number;
      manual_config: number;
    }>;
    return rows.map((r) => ({
      session: {
        repoId: r.repo_id,
        teamId: r.team_id,
        branch: r.branch,
        baseRevision: r.base_revision,
      },
      highestRevision: r.highest_revision,
      manualConfig: r.manual_config === 1,
    }));
  }

  appendEvent(event: PersistedEvent): void {
    try {
      this.db
        .prepare(
          `INSERT INTO events (session_key, event_revision, event_id, type, device_id, payload_json, replay_counter, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          sessionKey(event.session),
          event.eventRevision,
          event.eventId,
          event.type,
          event.deviceId,
          event.payloadJson,
          event.replayCounter,
          event.createdAt,
        );
    } catch (error) {
      throw new StoreError(
        `Failed to persist event ${event.eventId} (rev ${event.eventRevision}).`,
        { cause: error },
      );
    }
  }

  eventsSince(session: SessionId, fromRevision: number): PersistedEvent[] {
    const rows = this.db
      .prepare(
        `SELECT event_revision, event_id, type, device_id, payload_json, replay_counter, created_at
         FROM events WHERE session_key = ? AND event_revision > ? ORDER BY event_revision ASC`,
      )
      .all(sessionKey(session), fromRevision) as Array<{
      event_revision: number;
      event_id: string;
      type: string;
      device_id: string;
      payload_json: string;
      replay_counter: number;
      created_at: string;
    }>;
    return rows.map((r) => ({
      session,
      eventRevision: r.event_revision,
      eventId: r.event_id,
      type: r.type,
      deviceId: r.device_id,
      payloadJson: r.payload_json,
      replayCounter: r.replay_counter,
      createdAt: r.created_at,
    }));
  }

  hasAppliedEventId(session: SessionId, eventId: string): number | null {
    const row = this.db
      .prepare(
        `SELECT event_revision FROM applied_events WHERE session_key = ? AND event_id = ?`,
      )
      .get(sessionKey(session), eventId) as
      | { event_revision: number }
      | undefined;
    return row?.event_revision ?? null;
  }

  recordApplied(session: SessionId, eventId: string, eventRevision: number): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO applied_events (session_key, event_id, event_revision) VALUES (?, ?, ?)`,
      )
      .run(sessionKey(session), eventId, eventRevision);
  }

  appliedEvents(session: SessionId): { eventId: string; eventRevision: number }[] {
    const rows = this.db
      .prepare(
        `SELECT event_id, event_revision FROM applied_events WHERE session_key = ?`,
      )
      .all(sessionKey(session)) as Array<{
      event_id: string;
      event_revision: number;
    }>;
    return rows.map((r) => ({ eventId: r.event_id, eventRevision: r.event_revision }));
  }

  deviceCounters(): { deviceId: string; highestCounter: number }[] {
    const rows = this.db
      .prepare(
        `SELECT device_id, MAX(replay_counter) AS highest_counter FROM events GROUP BY device_id`,
      )
      .all() as Array<{ device_id: string; highest_counter: number }>;
    return rows.map((r) => ({
      deviceId: r.device_id,
      highestCounter: r.highest_counter,
    }));
  }

  appendAudit(record: AuditRecord & { session: SessionId }): void {
    this.db
      .prepare(
        `INSERT INTO audit (session_key, member_id, device_id, action, target_scope, override_reason, event_revision, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionKey(record.session),
        record.member.memberId,
        record.member.deviceId,
        record.action,
        record.targetScope,
        record.overrideReason ?? null,
        record.eventRevision,
        record.time,
      );
  }

  auditRecords(session: SessionId): AuditRecord[] {
    const rows = this.db
      .prepare(
        `SELECT member_id, device_id, action, target_scope, override_reason, event_revision, created_at
         FROM audit WHERE session_key = ? ORDER BY id ASC`,
      )
      .all(sessionKey(session)) as Array<{
      member_id: string;
      device_id: string;
      action: string;
      target_scope: string;
      override_reason: string | null;
      event_revision: number;
      created_at: string;
    }>;
    return rows.map((r) => ({
      member: { memberId: r.member_id, deviceId: r.device_id },
      action: r.action as AuditRecord["action"],
      targetScope: r.target_scope,
      eventRevision: r.event_revision,
      time: r.created_at,
      ...(r.override_reason !== null ? { overrideReason: r.override_reason } : {}),
    }));
  }

  membership(session: SessionId): MembershipRegistryEntry[] {
    const rows = this.db
      .prepare(
        `SELECT device_pubkey, member_id, invitation_valid, revoked, rotated_from
         FROM membership WHERE session_key = ?`,
      )
      .all(sessionKey(session)) as Array<{
      device_pubkey: string;
      member_id: string;
      invitation_valid: number;
      revoked: number;
      rotated_from: string | null;
    }>;
    return rows.map((r) => ({
      devicePublicKey: r.device_pubkey,
      memberId: r.member_id,
      invitationValid: r.invitation_valid === 1,
      revoked: r.revoked === 1,
      ...(r.rotated_from !== null ? { rotatedFrom: r.rotated_from } : {}),
    }));
  }

  replaceMembership(session: SessionId, entries: readonly MembershipRegistryEntry[]): void {
    const key = sessionKey(session);
    this.transaction(() => {
      this.db.prepare(`DELETE FROM membership WHERE session_key = ?`).run(key);
      const insert = this.db.prepare(
        `INSERT INTO membership (session_key, device_pubkey, member_id, invitation_valid, revoked, rotated_from)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const e of entries) {
        insert.run(
          key,
          e.devicePublicKey,
          e.memberId,
          e.invitationValid ? 1 : 0,
          e.revoked ? 1 : 0,
          e.rotatedFrom ?? null,
        );
      }
    });
  }

  adminKeys(session: SessionId): string[] {
    const rows = this.db
      .prepare(`SELECT device_pubkey FROM admin_keys WHERE session_key = ?`)
      .all(sessionKey(session)) as Array<{ device_pubkey: string }>;
    return rows.map((r) => r.device_pubkey);
  }

  setAdminKeys(session: SessionId, keys: readonly string[]): void {
    const key = sessionKey(session);
    this.transaction(() => {
      this.db.prepare(`DELETE FROM admin_keys WHERE session_key = ?`).run(key);
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO admin_keys (session_key, device_pubkey) VALUES (?, ?)`,
      );
      for (const k of keys) insert.run(key, k);
    });
  }

  saveSnapshot(snapshot: SessionStateSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO snapshots (session_key, snapshot_json) VALUES (?, ?)
         ON CONFLICT(session_key) DO UPDATE SET snapshot_json = excluded.snapshot_json`,
      )
      .run(sessionKey(snapshot.session), JSON.stringify(snapshot));
  }

  loadSnapshot(session: SessionId): SessionStateSnapshot | null {
    const row = this.db
      .prepare(`SELECT snapshot_json FROM snapshots WHERE session_key = ?`)
      .get(sessionKey(session)) as { snapshot_json: string } | undefined;
    if (row === undefined) return null;
    return JSON.parse(row.snapshot_json) as SessionStateSnapshot;
  }

  upsertDependencyGraph(session: SessionId, graph: DependencyGraph): void {
    this.db
      .prepare(
        `INSERT INTO dependency_graphs (session_key, graph_version, analyzer_version, graph_json)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(session_key) DO UPDATE SET
           graph_version = excluded.graph_version,
           analyzer_version = excluded.analyzer_version,
           graph_json = excluded.graph_json`,
      )
      .run(
        sessionKey(session),
        graph.snapshot.graphVersion,
        graph.snapshot.analyzerVersion,
        JSON.stringify(graph),
      );
  }

  getDependencyGraph(session: SessionId): DependencyGraph | null {
    const row = this.db
      .prepare(`SELECT graph_json FROM dependency_graphs WHERE session_key = ?`)
      .get(sessionKey(session)) as { graph_json: string } | undefined;
    if (row === undefined) return null;
    return JSON.parse(row.graph_json) as DependencyGraph;
  }

  close(): void {
    this.db.close();
  }

  /** Run `fn` inside an IMMEDIATE transaction, rolling back on error. */
  private transaction(fn: () => void): void {
    this.db.exec("BEGIN");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw new StoreError("Transaction failed.", { cause: error });
    }
  }
}
