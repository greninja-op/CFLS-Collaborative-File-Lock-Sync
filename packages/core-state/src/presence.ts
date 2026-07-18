/**
 * Presence registry — tracks Team_Member presence per member/path (Req 11).
 *
 * The {@link PresenceRegistry} is the pure, in-memory authority for
 * Presence_Events. It records the latest `started`/`editing`/`stopped` state for
 * each `(member, path)` pair within a `Repository_Session`, keyed by the opaque
 * {@link sessionKey} so unrelated repos/teams/branches never mix (Req 10.2).
 *
 * Like the lock registry it is dependency-free: the caller assigns the
 * authoritative `eventRevision` (task 4.4) and the registry orders solely by
 * that per-session total order — never by client time. Reports are applied
 * **monotonically**: a report is stored only when its Event_Revision is greater
 * than or equal to the currently stored revision for that member/path, so a
 * late-arriving stale event can never clobber a newer state. Paths are keyed by
 * their platform-aware normalized matching key so equivalent spellings of the
 * same file collapse to one presence entry (Req 10.3–10.4).
 *
 * A `stopped` report ends a member's presence on a path; the entry is retained
 * as an authoritative `stopped` record (with its Event_Revision) so consumers
 * can broadcast the end-of-editing transition (Req 11.2/11.3). {@link active}
 * filters those out to expose only members currently `started`/`editing`.
 */

import type { MemberRef, Presence, SessionId } from "@cfls/protocol";

import { normalizePath, pathMatchKey, type PlatformCaseSensitivity } from "./path";
import { sessionKey } from "./session";

/** A presence report; `eventRevision` is assigned by the caller (host counter). */
export interface PresenceReport {
  session: SessionId;
  member: MemberRef;
  /** Repository-relative path being edited (normalized for keying). */
  path: string;
  state: Presence["state"];
  /** Authoritative Event_Revision assigned by the host (Req 11.3). */
  eventRevision: number;
}

/** Per-member/path composite key within a session. */
function entryKey(
  member: MemberRef,
  path: string,
  sensitivity: PlatformCaseSensitivity | undefined,
): string {
  const pathKey = pathMatchKey(normalizePath(path), sensitivity);
  return `${member.memberId}\u0000${pathKey}`;
}

/**
 * Pure in-memory registry of Team_Member presence per member/path (Req 11).
 */
export class PresenceRegistry {
  /** `session_key` → (`member\u0000pathKey` → latest Presence). */
  private readonly sessions = new Map<string, Map<string, Presence>>();

  constructor(private readonly sensitivity?: PlatformCaseSensitivity) {}

  private entriesFor(session: SessionId): Map<string, Presence> {
    const key = sessionKey(session);
    let entries = this.sessions.get(key);
    if (entries === undefined) {
      entries = new Map<string, Presence>();
      this.sessions.set(key, entries);
    }
    return entries;
  }

  /**
   * Apply a presence report (Req 11.1–11.3). Records `started`/`editing`/
   * `stopped` for the reporting member on the normalized path, keeping the
   * original path spelling. The report is applied only when its Event_Revision
   * is not older than the stored one; a stale (lower-revision) report is ignored
   * and the currently stored presence is returned unchanged.
   */
  report(report: PresenceReport): Presence {
    const entries = this.entriesFor(report.session);
    const key = entryKey(report.member, report.path, this.sensitivity);
    const existing = entries.get(key);

    if (existing !== undefined && report.eventRevision < existing.eventRevision) {
      // Stale event: a newer state already applied. Leave state unchanged.
      return existing;
    }

    const presence: Presence = {
      member: report.member,
      path: normalizePath(report.path),
      state: report.state,
      eventRevision: report.eventRevision,
    };
    entries.set(key, presence);
    return presence;
  }

  /**
   * All presence entries for a session, including `stopped` records
   * (authoritative history of the latest transition per member/path).
   */
  all(session: SessionId): readonly Presence[] {
    const entries = this.sessions.get(sessionKey(session));
    return entries === undefined ? [] : Array.from(entries.values());
  }

  /**
   * Members currently present (state `started` or `editing`) in a session —
   * `stopped` entries are excluded (Req 11).
   */
  active(session: SessionId): readonly Presence[] {
    return this.all(session).filter((p) => p.state !== "stopped");
  }

  /** Active presence on a specific path (excludes `stopped`). */
  activeForPath(session: SessionId, path: string): readonly Presence[] {
    const targetKey = pathMatchKey(normalizePath(path), this.sensitivity);
    return this.active(session).filter(
      (p) => pathMatchKey(p.path, this.sensitivity) === targetKey,
    );
  }

  /**
   * Replace a session's entire presence state with a persisted set of entries
   * (authoritative-state restore after a host restart or a sync-snapshot
   * replacement — Req 1.5, 1.6, 9.5). Existing entries for the session are
   * discarded and each entry is reinstalled under its member/path key, preserving
   * `stopped` records. If a snapshot somehow carries duplicate entries for the
   * same member/path, the highest-Event_Revision entry wins, matching the
   * monotonic ordering enforced by {@link report}. Entries are deep-copied so the
   * registry never aliases the caller's snapshot objects.
   */
  restore(session: SessionId, presence: readonly Presence[]): void {
    const entries = new Map<string, Presence>();
    for (const item of presence) {
      const key = entryKey(item.member, item.path, this.sensitivity);
      const existing = entries.get(key);
      if (existing !== undefined && item.eventRevision < existing.eventRevision) {
        continue;
      }
      entries.set(key, {
        ...item,
        member: { ...item.member },
        path: normalizePath(item.path),
      });
    }
    this.sessions.set(sessionKey(session), entries);
  }

  /** The latest presence for a specific member/path, or `undefined`. */
  forMemberPath(
    session: SessionId,
    member: MemberRef,
    path: string,
  ): Presence | undefined {
    const entries = this.sessions.get(sessionKey(session));
    if (entries === undefined) {
      return undefined;
    }
    return entries.get(entryKey(member, path, this.sensitivity));
  }
}
