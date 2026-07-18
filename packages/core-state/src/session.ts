/**
 * Session identity and `session_key` hashing (Req 10.1–10.2; design §5.2, §7.4, §9).
 *
 * A `Repository_Session` is identified by the tuple `(repoId, teamId, branch,
 * baseRevision)` — see {@link SessionId} in `@cfls/protocol`. The host and agent
 * isolate all coordination state (events, locks, intents, presence, dependency
 * graphs) by a single opaque **`session_key`** derived from that tuple, so
 * unrelated repositories, teams, and branches never mix (Req 10.2, design §7.4).
 *
 * {@link sessionKey} produces that key as a stable SHA-256 over a canonical,
 * unambiguous encoding of the four fields. It is deterministic (equal tuples →
 * equal key) and injective in practice (length-prefixed encoding prevents field
 * boundaries from being confused, so distinct tuples do not collide). A missing
 * `baseRevision` (`null`) is encoded distinctly from any string value.
 *
 * {@link buildSessionId} assembles a {@link SessionId} while canonicalizing the
 * repository ID through {@link deriveRepoId}, so a session built from a raw
 * remote URL keys identically regardless of the remote's transport spelling.
 */

import { createHash } from "node:crypto";

import type { SessionId } from "@cfls/protocol";

import { deriveRepoId } from "./repo-id";

/**
 * Compute the canonical `session_key` for a {@link SessionId} (Req 10.2).
 *
 * Fields are encoded length-prefixed (`<len>:<value>`) so no combination of
 * field contents can be reinterpreted as a different tuple, then hashed with
 * SHA-256 and returned base64url-encoded. `baseRevision === null` is encoded as
 * a sentinel distinct from the empty string.
 */
export function sessionKey(session: SessionId): string {
  const fields = [
    session.repoId,
    session.teamId,
    session.branch,
    session.baseRevision === null ? "\u0000null" : `s:${session.baseRevision}`,
  ];
  const canonical = fields
    .map((value) => `${value.length}:${value}`)
    .join("|");
  return createHash("sha256").update(canonical, "utf8").digest("base64url");
}

/**
 * Build a {@link SessionId} from its parts, canonicalizing `repoId` from a raw
 * remote URL via {@link deriveRepoId} so transport variants of the same
 * repository produce the same session identity (Req 10.1). `baseRevision`
 * defaults to `null` when repository metadata is unavailable.
 */
export function buildSessionId(input: {
  remote: string;
  teamId: string;
  branch: string;
  baseRevision?: string | null;
}): SessionId {
  return {
    repoId: deriveRepoId(input.remote),
    teamId: input.teamId,
    branch: input.branch,
    baseRevision: input.baseRevision ?? null,
  };
}
