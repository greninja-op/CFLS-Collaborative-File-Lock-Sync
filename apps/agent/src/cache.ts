/**
 * Local encrypted coordination cache (task 9.5; Req 35.1–35.4; design §4.6).
 *
 * The agent persists the last-known authoritative coordination state per
 * `Repository_Session` so it can serve a (stale-marked) view while offline and
 * record the highest applied Event_Revision to drive reconnect
 * sync-from-revision (Req 35.1). The cache holds **metadata only** — the
 * serialized {@link SessionStateSnapshot} (locks/presence/intents/revisions) —
 * and NEVER source content or secrets (Req 35.3): it is written to disk
 * encrypted with AES-256-GCM under a key derived from the agent's own key
 * material, so at-rest cache bytes reveal neither the coordination metadata nor
 * any incidental source.
 *
 * This module owns only encryption + file I/O; the snapshot shape and its
 * serialize/restore live in `@cfls/core-state`.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { findMinimizationViolations } from "@cfls/core-state";
import type { SessionId, SessionStateSnapshot } from "@cfls/protocol";
import { sessionKey } from "@cfls/core-state";

const ALGORITHM = "aes-256-gcm";
const KEY_LEN = 32;
const IV_LEN = 12;
const SALT_LEN = 16;
const MAGIC = "cfls-cache-v1";

/** The on-disk encrypted envelope (all binary fields base64). */
interface CacheRecord {
  magic: string;
  salt: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

/** Options for {@link EncryptedCache}. */
export interface EncryptedCacheOptions {
  /** Directory the per-session cache files live in. Created if missing. */
  dir: string;
  /**
   * Passphrase mixed into the per-file scrypt key derivation. Supply the agent's
   * Device_Private_Key (or another per-user secret) so the cache is bound to
   * this agent and unreadable by others.
   */
  passphrase: string;
}

/**
 * AES-256-GCM encrypted, per-session coordination-state cache (Req 35.1, 35.3).
 * Each session's snapshot is stored in its own file keyed by the opaque
 * {@link sessionKey}, so unrelated sessions never share ciphertext.
 */
export class EncryptedCache {
  private readonly dir: string;
  private readonly passphrase: string;

  constructor(options: EncryptedCacheOptions) {
    this.dir = options.dir;
    this.passphrase = options.passphrase;
  }

  private fileFor(session: SessionId): string {
    // sessionKey is a hex/opaque hash — safe as a file basename.
    return join(this.dir, `${sessionKey(session)}.cache`);
  }

  /**
   * Persist a session's authoritative snapshot, encrypted (Req 35.1). Rejects a
   * snapshot that would carry source content or secrets, enforcing the
   * metadata-only guarantee before anything touches disk (Req 35.3).
   */
  save(session: SessionId, snapshot: SessionStateSnapshot): void {
    const violations = findMinimizationViolations(snapshot);
    if (violations.length > 0) {
      throw new Error(
        `Refusing to cache a snapshot carrying non-metadata content (Req 35.3): ` +
          violations.map((v) => v.kind).join(", "),
      );
    }
    mkdirSync(this.dir, { recursive: true });
    const salt = randomBytes(SALT_LEN);
    const key = scryptSync(this.passphrase, salt, KEY_LEN);
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const plaintext = Buffer.from(JSON.stringify(snapshot), "utf8");
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    const record: CacheRecord = {
      magic: MAGIC,
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    writeFileSync(this.fileFor(session), JSON.stringify(record), {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  /**
   * Load and decrypt a session's cached snapshot, or `null` when none is stored
   * or the file is unreadable/corrupt (the agent then relies on a fresh host
   * sync — Req 35.4).
   */
  load(session: SessionId): SessionStateSnapshot | null {
    const path = this.fileFor(session);
    if (!existsSync(path)) {
      return null;
    }
    try {
      const record = JSON.parse(readFileSync(path, "utf8")) as CacheRecord;
      if (record.magic !== MAGIC) {
        return null;
      }
      const salt = Buffer.from(record.salt, "base64");
      const iv = Buffer.from(record.iv, "base64");
      const authTag = Buffer.from(record.authTag, "base64");
      const ciphertext = Buffer.from(record.ciphertext, "base64");
      const key = scryptSync(this.passphrase, salt, KEY_LEN);
      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(authTag);
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      return JSON.parse(plaintext.toString("utf8")) as SessionStateSnapshot;
    } catch {
      return null;
    }
  }
}
