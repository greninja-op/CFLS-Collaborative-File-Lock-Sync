/**
 * Declared-intent lifecycle and Planned_File_Creation collision detection
 * (Req 16.1–16.8, 17.1–17.5, 18.1–18.3, 32.1–32.5; design §5.1, §10.2).
 *
 * The {@link IntentRegistry} is the pure, in-memory authority for
 * `Declared_Intent`s — an AI_Agent's declaration of the files it plans to modify
 * and create. Like {@link import('./locks').LockRegistry} it is dependency-free
 * (no I/O, no clocks): callers assign the authoritative `eventRevision` (from the
 * host's monotonic {@link import('./revisions').RevisionCounter}, task 4.4) and
 * the registry records it verbatim. Ordering and conflict resolution are driven
 * exclusively by the per-session Event_Revision total order, never raw client
 * time (design §10.2).
 *
 * State is isolated per `Repository_Session` (keyed by the opaque
 * {@link sessionKey}) so unrelated repos/teams/branches never mix (Req 10.2).
 *
 * ## Lifecycle (Req 16)
 * - {@link IntentRegistry.declare} records a new intent with all Req 16.2 fields.
 * - {@link IntentRegistry.update} replaces an owned intent's modify/create/
 *   description and stamps a new revision (Req 16.3); a non-owner is rejected
 *   with `NOT_OWNER` and the intent is retained unchanged (Req 16.8).
 * - {@link IntentRegistry.withdraw} / {@link IntentRegistry.complete} remove an
 *   owned intent (Req 16.4); a non-owner is rejected with `NOT_OWNER` (Req 16.8).
 * - Declarations that exceed the 4096-char path limit or supply neither a modify
 *   nor a create set are rejected with `FORMAT_ERROR`, leaving state unchanged
 *   (Req 16.7); a malformed glob scope is likewise rejected (Req 32.4).
 *
 * ## Reclassification (Req 16.5)
 * A Planned_File_Creation whose path already exists as a tracked file is
 * recorded as a planned **modification** instead, and the caller is told the
 * path already existed (`reclassified`).
 *
 * ## Reconciliation with real saves/creations (Req 17)
 * - {@link IntentRegistry.reconcileCreation} records an actually-created path as
 *   a tracked file and removes any matching Planned_File_Creation (Req 17.2,
 *   17.3).
 * - {@link IntentRegistry.reconcileSave} marks a planned modification as
 *   in-progress (Req 17.1).
 * - {@link IntentRegistry.withdrawPlannedCreation} removes a not-yet-created
 *   Planned_File_Creation from an owned intent (Req 17.5).
 *
 * ## Collision detection (Req 18)
 * Planned_File_Creations for the same path under the same Branch_Context contend.
 * The winner is the claim with the **earliest assigned Event_Revision**; every
 * other declaration is recorded as a concurrent claim and told the winning
 * member + revision (Req 18.1, 18.3; design §10.2). Winner selection is
 * recomputed deterministically from revisions on every mutation, so it is
 * independent of the order claims arrive in.
 *
 * ## Scoped intents (Req 32)
 * An `Intent_Scope` is a single repository-relative file path, folder path, or
 * glob pattern (Req 32.5). {@link IntentRegistry.intentsCovering} returns every
 * active intent whose scope covers a queried path (Req 32.2, 32.3).
 */

import type {
  DeclaredIntent,
  MemberRef,
  PlannedFileCreation,
  ScopeKind,
  SessionId,
} from "@cfls/protocol";

import { normalizePath, normalizePathKey, type PlatformCaseSensitivity } from "./path";
import { globMatch } from "./rules";
import { sessionKey } from "./session";

/** Maximum repository-relative path/scope length (Req 16.7, 12.3). */
const MAX_PATH_LENGTH = 4096;

/** The three valid Intent_Scope kinds (Req 32.5). */
const SCOPE_KINDS: readonly ScopeKind[] = ["file", "folder", "glob"];

/** Error codes surfaced by intent operations (design §11.1). */
export type IntentError = "FORMAT_ERROR" | "NOT_OWNER" | "NOT_FOUND";

/** A request to declare a new Declared_Intent; `eventRevision` is caller-assigned. */
export interface DeclareIntentRequest {
  session: SessionId;
  /** Opaque intent identifier (assigned upstream, e.g. from the Event_ID). */
  intentId: string;
  owner: MemberRef;
  /** AI_Agent identifier (Req 16.2). */
  agentId: string;
  /** Repository-relative paths the agent plans to modify. */
  modifyPaths: readonly string[];
  /** Repository-relative paths the agent plans to create. */
  createPaths: readonly string[];
  /** Intent_Scope kind: file/folder/glob (Req 32.5). */
  scopeKind: ScopeKind;
  /** Branch_Context under which the intent is declared. */
  branch: string;
  description: string;
  /** Authoritative Event_Revision assigned by the host (Req 16.1). */
  eventRevision: number;
}

/** A request to update an existing owned Declared_Intent (Req 16.3). */
export interface UpdateIntentRequest {
  session: SessionId;
  intentId: string;
  requester: MemberRef;
  modifyPaths: readonly string[];
  createPaths: readonly string[];
  description: string;
  /** New Event_Revision for the update (Req 16.3). */
  eventRevision: number;
}

/** A request to withdraw or complete an owned Declared_Intent (Req 16.4). */
export interface WithdrawIntentRequest {
  session: SessionId;
  intentId: string;
  requester: MemberRef;
}

/** A path reclassified from a Planned_File_Creation to a modification (Req 16.5). */
export interface Reclassification {
  path: string;
  /** Always `modify`: the create was demoted because the path already exists. */
  as: "modify";
  reason: "path_exists";
}

/**
 * A concurrent Planned_File_Creation claim detected against an existing winner
 * (Req 18.1). Reports the winning member and its Event_Revision so the caller
 * can broadcast the collision (Req 18.2).
 */
export interface PlannedCreationConflict {
  /** The normalized repository-relative path both members plan to create. */
  path: string;
  /** The winning claim (earliest Event_Revision). */
  winner: { holder: MemberRef; eventRevision: number; intentId: string };
  /** The concurrent (losing) claimant. */
  concurrent: { holder: MemberRef; eventRevision: number; intentId: string };
}

/** Result of {@link IntentRegistry.declare} / {@link IntentRegistry.update}. */
export type DeclareResult =
  | {
      ok: true;
      intent: DeclaredIntent;
      /** Create paths demoted to modifications because they already exist (Req 16.5). */
      reclassified: Reclassification[];
      /** Concurrent Planned_File_Creation claims detected for this intent (Req 18.1). */
      conflicts: PlannedCreationConflict[];
    }
  | { ok: false; code: IntentError; errors?: string[] };

/** Result of {@link IntentRegistry.withdraw} / {@link IntentRegistry.complete}. */
export type WithdrawResult =
  | { ok: true; removed: DeclaredIntent }
  | { ok: false; code: IntentError };

/** Result of {@link IntentRegistry.reconcileCreation} (Req 17.2, 17.3). */
export interface CreationReconciliation {
  /** True when the path was newly recorded as a tracked file. */
  trackedAdded: boolean;
  /** Intents from which a matching Planned_File_Creation was removed (Req 17.2). */
  removedFrom: DeclaredIntent[];
}

/** Result of {@link IntentRegistry.reconcileSave} (Req 17.1). */
export interface SaveReconciliation {
  /** Intents whose planned modification of the saved path is now in-progress. */
  inProgress: DeclaredIntent[];
}

/** Result of {@link IntentRegistry.withdrawPlannedCreation} (Req 17.5). */
export type WithdrawCreationResult =
  | { ok: true; intent: DeclaredIntent; removedPath: string }
  | { ok: false; code: IntentError };

/** An intent covering a queried path, plus how it covers it (Req 32.3). */
export interface CoveringIntent {
  intent: DeclaredIntent;
  /** Which of the intent's scopes matched the queried path. */
  matchedScope: string;
}

/** Internal mutable record of a stored intent. */
interface StoredIntent {
  intent: DeclaredIntent;
  /** Planned-modification paths reported as in-progress via a real save (Req 17.1). */
  inProgress: Set<string>;
}

/** True if a glob pattern is malformed (unbalanced brackets or empty) (Req 32.4). */
function isMalformedGlob(glob: string): boolean {
  if (glob.trim().length === 0) {
    return true;
  }
  let depth = 0;
  for (const ch of glob) {
    if (ch === "[") {
      depth += 1;
    } else if (ch === "]") {
      depth -= 1;
      if (depth < 0) {
        return true;
      }
    }
  }
  return depth !== 0;
}

/**
 * Pure in-memory registry of Declared_Intents and Planned_File_Creation claims
 * (Req 16, 17, 18, 32; design §5.1, §10.2).
 */
export class IntentRegistry {
  /** `session_key` → (`intentId` → stored intent). */
  private readonly sessions = new Map<string, Map<string, StoredIntent>>();

  /** `session_key` → set of tracked-file path keys that already exist. */
  private readonly tracked = new Map<string, Set<string>>();

  /**
   * Optional platform case-sensitivity used to normalize file/folder scopes.
   * When omitted, {@link normalizePathKey}'s platform default applies.
   */
  constructor(private readonly sensitivity?: PlatformCaseSensitivity) {}

  private intentsFor(session: SessionId): Map<string, StoredIntent> {
    const key = sessionKey(session);
    let intents = this.sessions.get(key);
    if (intents === undefined) {
      intents = new Map<string, StoredIntent>();
      this.sessions.set(key, intents);
    }
    return intents;
  }

  private trackedFor(session: SessionId): Set<string> {
    const key = sessionKey(session);
    let files = this.tracked.get(key);
    if (files === undefined) {
      files = new Set<string>();
      this.tracked.set(key, files);
    }
    return files;
  }

  private pathKey(path: string): string {
    return normalizePathKey(path, this.sensitivity);
  }

  /**
   * Seed the set of already-existing tracked files for a session so create
   * declarations for existing paths are reclassified (Req 16.5). Paths are
   * normalized to their platform-aware match keys.
   */
  setTrackedFiles(session: SessionId, paths: Iterable<string>): void {
    const files = this.trackedFor(session);
    for (const path of paths) {
      files.add(this.pathKey(path));
    }
  }

  /** Record a single path as a tracked (existing) file. */
  markTracked(session: SessionId, path: string): void {
    this.trackedFor(session).add(this.pathKey(path));
  }

  /** Whether a repository-relative path is currently a tracked (existing) file. */
  isTracked(session: SessionId, path: string): boolean {
    return this.tracked.get(sessionKey(session))?.has(this.pathKey(path)) ?? false;
  }

  /**
   * Validate paths (Req 16.7, 32.4). Returns an array of error messages; empty
   * when valid. A path exceeding {@link MAX_PATH_LENGTH} chars, an empty
   * modify+create pair, or a malformed glob scope are all rejected.
   */
  private validate(
    modifyPaths: readonly string[],
    createPaths: readonly string[],
    scopeKind: ScopeKind,
  ): string[] {
    const errors: string[] = [];

    if (!SCOPE_KINDS.includes(scopeKind)) {
      errors.push(`Invalid scopeKind '${String(scopeKind)}'; expected file, folder, or glob.`);
    }

    if (modifyPaths.length === 0 && createPaths.length === 0) {
      errors.push("Declared_Intent must include at least one modify or create path.");
    }

    for (const path of [...modifyPaths, ...createPaths]) {
      if (path.length > MAX_PATH_LENGTH) {
        errors.push(`Path exceeds ${MAX_PATH_LENGTH} characters: '${path.slice(0, 32)}…'.`);
      }
      if (scopeKind === "glob" && isMalformedGlob(path)) {
        errors.push(`Malformed glob pattern: '${path}'.`);
      }
    }

    return errors;
  }

  /**
   * Reclassify create paths that already exist as tracked files into
   * modifications (Req 16.5). Returns the resolved modify/create sets and the
   * list of reclassifications.
   */
  private reclassify(
    session: SessionId,
    modifyPaths: readonly string[],
    createPaths: readonly string[],
  ): {
    modify: string[];
    create: PlannedFileCreation[];
    reclassified: Reclassification[];
  } {
    const modify = modifyPaths.map((p) => normalizePath(p));
    const create: PlannedFileCreation[] = [];
    const reclassified: Reclassification[] = [];

    for (const raw of createPaths) {
      const normalized = normalizePath(raw);
      if (this.isTracked(session, raw)) {
        // The path already exists ⇒ record as a modification, not a creation.
        if (!modify.includes(normalized)) {
          modify.push(normalized);
        }
        reclassified.push({ path: normalized, as: "modify", reason: "path_exists" });
      } else {
        create.push({ path: normalized });
      }
    }

    return { modify, create, reclassified };
  }

  /**
   * Compute the Planned_File_Creation conflicts for a given intent: for each of
   * its create paths, if another member holds the winning claim for that
   * `(path, branch)`, report it (Req 18.1, 18.3; design §10.2). The winner is
   * the claim with the earliest Event_Revision across all active intents.
   */
  private conflictsFor(
    session: SessionId,
    intent: DeclaredIntent,
  ): PlannedCreationConflict[] {
    const conflicts: PlannedCreationConflict[] = [];

    for (const creation of intent.createPaths) {
      const claims = this.creationClaims(session, creation.path, intent.branch);
      const winner = claims[0];
      if (
        winner !== undefined &&
        winner.intent.intentId !== intent.intentId &&
        winner.intent.owner.memberId !== intent.owner.memberId
      ) {
        conflicts.push({
          path: normalizePath(creation.path),
          winner: {
            holder: winner.intent.owner,
            eventRevision: winner.intent.eventRevision,
            intentId: winner.intent.intentId,
          },
          concurrent: {
            holder: intent.owner,
            eventRevision: intent.eventRevision,
            intentId: intent.intentId,
          },
        });
      }
    }

    return conflicts;
  }

  /**
   * Declare a new Declared_Intent (Req 16.1, 16.2). Validates paths (Req 16.7,
   * 32.4), reclassifies existing create paths to modifications (Req 16.5),
   * records the intent verbatim with the caller's Event_Revision, and reports any
   * concurrent Planned_File_Creation claims (Req 18.1). On validation failure the
   * authoritative state is left unchanged.
   */
  declare(request: DeclareIntentRequest): DeclareResult {
    const errors = this.validate(
      request.modifyPaths,
      request.createPaths,
      request.scopeKind,
    );
    if (errors.length > 0) {
      return { ok: false, code: "FORMAT_ERROR", errors };
    }

    const { modify, create, reclassified } = this.reclassify(
      request.session,
      request.modifyPaths,
      request.createPaths,
    );

    const intent: DeclaredIntent = {
      intentId: request.intentId,
      owner: request.owner,
      agentId: request.agentId,
      modifyPaths: modify,
      createPaths: create,
      scopeKind: request.scopeKind,
      branch: request.branch,
      description: request.description,
      eventRevision: request.eventRevision,
    };

    const intents = this.intentsFor(request.session);
    intents.set(intent.intentId, { intent, inProgress: new Set() });

    return {
      ok: true,
      intent,
      reclassified,
      conflicts: this.conflictsFor(request.session, intent),
    };
  }

  /**
   * Update an existing owned Declared_Intent (Req 16.3). Rejects with
   * `NOT_FOUND` when the intent is unknown and with `NOT_OWNER` — retaining the
   * intent unchanged — when the requester is not the owner (Req 16.8). Otherwise
   * replaces modify/create/description, stamps the new Event_Revision, and
   * recomputes reclassifications and conflicts.
   */
  update(request: UpdateIntentRequest): DeclareResult {
    const intents = this.intentsFor(request.session);
    const stored = intents.get(request.intentId);
    if (stored === undefined) {
      return { ok: false, code: "NOT_FOUND" };
    }
    if (stored.intent.owner.memberId !== request.requester.memberId) {
      // Non-owner update: retain the intent unchanged (Req 16.8).
      return { ok: false, code: "NOT_OWNER" };
    }

    const errors = this.validate(
      request.modifyPaths,
      request.createPaths,
      stored.intent.scopeKind,
    );
    if (errors.length > 0) {
      return { ok: false, code: "FORMAT_ERROR", errors };
    }

    const { modify, create, reclassified } = this.reclassify(
      request.session,
      request.modifyPaths,
      request.createPaths,
    );

    const intent: DeclaredIntent = {
      ...stored.intent,
      modifyPaths: modify,
      createPaths: create,
      description: request.description,
      eventRevision: request.eventRevision,
    };

    // Preserve in-progress markers for modify paths that survive the update.
    const survivingInProgress = new Set(
      [...stored.inProgress].filter((p) => modify.includes(p)),
    );
    intents.set(intent.intentId, { intent, inProgress: survivingInProgress });

    return {
      ok: true,
      intent,
      reclassified,
      conflicts: this.conflictsFor(request.session, intent),
    };
  }

  /**
   * Withdraw an owned Declared_Intent (Req 16.4). Rejects with `NOT_FOUND` when
   * unknown and `NOT_OWNER` — retaining the intent — when the requester is not
   * the owner (Req 16.8). On success removes the intent and its
   * Planned_File_Creation claims.
   */
  withdraw(request: WithdrawIntentRequest): WithdrawResult {
    const intents = this.intentsFor(request.session);
    const stored = intents.get(request.intentId);
    if (stored === undefined) {
      return { ok: false, code: "NOT_FOUND" };
    }
    if (stored.intent.owner.memberId !== request.requester.memberId) {
      return { ok: false, code: "NOT_OWNER" };
    }
    intents.delete(request.intentId);
    return { ok: true, removed: stored.intent };
  }

  /**
   * Complete an owned Declared_Intent (Req 16.4). Completion is removal with the
   * same ownership enforcement as {@link withdraw}.
   */
  complete(request: WithdrawIntentRequest): WithdrawResult {
    return this.withdraw(request);
  }

  /**
   * Reconcile an actual file creation confirmed by the filesystem watcher
   * (Req 17.2, 17.3). Records the path as a tracked file and removes any matching
   * Planned_File_Creation from active intents (recomputing collision winners for
   * that path). A creation not planned by any intent is still recorded as a
   * tracked file (Req 17.3).
   */
  reconcileCreation(session: SessionId, path: string): CreationReconciliation {
    const files = this.trackedFor(session);
    const key = this.pathKey(path);
    const trackedAdded = !files.has(key);
    files.add(key);

    const removedFrom: DeclaredIntent[] = [];
    const intents = this.intentsFor(session);
    for (const stored of intents.values()) {
      const before = stored.intent.createPaths.length;
      const remaining = stored.intent.createPaths.filter(
        (creation) => this.pathKey(creation.path) !== key,
      );
      if (remaining.length !== before) {
        stored.intent = { ...stored.intent, createPaths: remaining };
        removedFrom.push(stored.intent);
      }
    }

    return { trackedAdded, removedFrom };
  }

  /**
   * Reconcile a real save on a planned-modification path (Req 17.1). Marks the
   * saved path as in-progress on every active intent that lists it as a planned
   * modification and returns those intents so the caller can broadcast the
   * change.
   */
  reconcileSave(session: SessionId, path: string): SaveReconciliation {
    const key = this.pathKey(path);
    const inProgress: DeclaredIntent[] = [];
    const intents = this.intentsFor(session);
    for (const stored of intents.values()) {
      const matches = stored.intent.modifyPaths.some(
        (p) => this.pathKey(p) === key,
      );
      if (matches) {
        stored.inProgress.add(normalizePath(path));
        inProgress.push(stored.intent);
      }
    }
    return { inProgress };
  }

  /**
   * Withdraw a not-yet-created Planned_File_Creation from an owned intent
   * (Req 17.5). Rejects with `NOT_FOUND` when the intent or path is unknown and
   * `NOT_OWNER` when the requester is not the owner. On success removes the
   * Planned_File_Creation and returns the updated intent.
   */
  withdrawPlannedCreation(
    session: SessionId,
    intentId: string,
    path: string,
    requester: MemberRef,
  ): WithdrawCreationResult {
    const intents = this.intentsFor(session);
    const stored = intents.get(intentId);
    if (stored === undefined) {
      return { ok: false, code: "NOT_FOUND" };
    }
    if (stored.intent.owner.memberId !== requester.memberId) {
      return { ok: false, code: "NOT_OWNER" };
    }
    const key = this.pathKey(path);
    const remaining = stored.intent.createPaths.filter(
      (creation) => this.pathKey(creation.path) !== key,
    );
    if (remaining.length === stored.intent.createPaths.length) {
      return { ok: false, code: "NOT_FOUND" };
    }
    stored.intent = { ...stored.intent, createPaths: remaining };
    return { ok: true, intent: stored.intent, removedPath: normalizePath(path) };
  }

  /**
   * Return every active Planned_File_Creation claim for a `(path, branch)`,
   * ordered by Event_Revision ascending (earliest = winner) with `intentId` as a
   * deterministic tie-break (design §10.2). The first element is the winner; the
   * rest are concurrent claims (Req 18.1, 18.3).
   */
  creationClaims(
    session: SessionId,
    path: string,
    branch: string,
  ): { intent: DeclaredIntent; concurrent: boolean }[] {
    const key = this.pathKey(path);
    const intents = this.sessions.get(sessionKey(session));
    if (intents === undefined) {
      return [];
    }
    const matching: DeclaredIntent[] = [];
    for (const stored of intents.values()) {
      if (stored.intent.branch !== branch) {
        continue;
      }
      if (stored.intent.createPaths.some((c) => this.pathKey(c.path) === key)) {
        matching.push(stored.intent);
      }
    }
    matching.sort((a, b) =>
      a.eventRevision !== b.eventRevision
        ? a.eventRevision - b.eventRevision
        : a.intentId < b.intentId
          ? -1
          : a.intentId > b.intentId
            ? 1
            : 0,
    );
    return matching.map((intent, index) => ({ intent, concurrent: index > 0 }));
  }

  /**
   * The winning Planned_File_Creation claim for a `(path, branch)` — the claim
   * with the earliest Event_Revision — or `undefined` when none exists
   * (Req 18.3).
   */
  creationWinner(
    session: SessionId,
    path: string,
    branch: string,
  ): DeclaredIntent | undefined {
    return this.creationClaims(session, path, branch)[0]?.intent;
  }

  /**
   * Return every active intent whose Intent_Scope covers a queried
   * repository-relative path under `branch` (Req 32.2, 32.3). Coverage depends on
   * the intent's `scopeKind`: a `file` scope covers an equal path, a `folder`
   * scope covers paths contained within it, and a `glob` scope covers matching
   * paths. Both modify and create scopes are considered.
   */
  intentsCovering(
    session: SessionId,
    path: string,
    branch: string,
  ): CoveringIntent[] {
    const intents = this.sessions.get(sessionKey(session));
    if (intents === undefined) {
      return [];
    }
    const covering: CoveringIntent[] = [];
    for (const stored of intents.values()) {
      const { intent } = stored;
      if (intent.branch !== branch) {
        continue;
      }
      const scopes = [
        ...intent.modifyPaths,
        ...intent.createPaths.map((c) => c.path),
      ];
      const matched = scopes.find((scope) =>
        this.covers(scope, intent.scopeKind, path),
      );
      if (matched !== undefined) {
        covering.push({ intent, matchedScope: matched });
      }
    }
    return covering;
  }

  /** Whether a single `scope` of the given kind covers `path` (Req 32.2). */
  private covers(scope: string, scopeKind: ScopeKind, path: string): boolean {
    if (scopeKind === "glob") {
      return globMatch(scope, path);
    }
    const scopeK = this.pathKey(scope);
    const pathK = this.pathKey(path);
    if (scopeKind === "folder") {
      return pathK === scopeK || pathK.startsWith(`${scopeK}/`);
    }
    // file scope: exact path match.
    return scopeK === pathK;
  }

  /** Fetch a single intent by id, or `undefined` when absent. */
  getIntent(session: SessionId, intentId: string): DeclaredIntent | undefined {
    return this.sessions.get(sessionKey(session))?.get(intentId)?.intent;
  }

  /** The in-progress planned-modification paths recorded for an intent (Req 17.1). */
  inProgressPaths(session: SessionId, intentId: string): readonly string[] {
    const stored = this.sessions.get(sessionKey(session))?.get(intentId);
    return stored === undefined ? [] : [...stored.inProgress];
  }

  /**
   * Remove every Declared_Intent owned by the given `deviceId`, across the
   * session — the stale-intent expiry primitive (Req 26.3). Intents owned by any
   * other device are left untouched. Returns the removed intents so the caller
   * can emit removal events (Req 26.4); an empty array means the device owned no
   * intents. Tracked-file state is intentionally preserved (a created file does
   * not un-exist when its author disconnects).
   */
  expireByDevice(session: SessionId, deviceId: string): DeclaredIntent[] {
    const intents = this.sessions.get(sessionKey(session));
    if (intents === undefined) {
      return [];
    }
    const removed: DeclaredIntent[] = [];
    for (const [intentId, stored] of [...intents]) {
      if (stored.intent.owner.deviceId === deviceId) {
        removed.push(stored.intent);
        intents.delete(intentId);
      }
    }
    return removed;
  }

  /**
   * Replace a session's entire intent state with a persisted set of intents
   * (authoritative-state restore after a host restart or a sync-snapshot
   * replacement — Req 1.5, 1.6, 9.5). Existing intents for the session are
   * discarded and each intent is reinstalled verbatim (deep-copied so the
   * registry never aliases the caller's snapshot objects). Planned_File_Creation
   * collision winners are still recomputed deterministically from Event_Revisions
   * on demand via {@link creationClaims}, so restoring in any order yields the
   * same winners. In-progress markers (Req 17.1) are not part of the persisted
   * snapshot (design §5.2) and reset to empty on restore. Tracked-file state is
   * left untouched.
   */
  restore(session: SessionId, intents: readonly DeclaredIntent[]): void {
    const map = new Map<string, StoredIntent>();
    for (const intent of intents) {
      map.set(intent.intentId, {
        intent: {
          ...intent,
          owner: { ...intent.owner },
          modifyPaths: [...intent.modifyPaths],
          createPaths: intent.createPaths.map((creation) => ({ ...creation })),
        },
        inProgress: new Set(),
      });
    }
    this.sessions.set(sessionKey(session), map);
  }

  /** All active intents recorded for a session. */
  allIntents(session: SessionId): readonly DeclaredIntent[] {
    const intents = this.sessions.get(sessionKey(session));
    if (intents === undefined) {
      return [];
    }
    return [...intents.values()].map((stored) => stored.intent);
  }
}
