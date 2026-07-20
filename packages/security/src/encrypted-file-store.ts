/**
 * Encrypted-file fallback secret store (design §8.2).
 *
 * When the OS credential store is unavailable, secrets are stored on disk under a
 * per-user app-data directory, encrypted with AES-256-GCM. The symmetric key is
 * derived (scrypt) from a per-user/host-scoped passphrase plus a random per-file
 * salt, and the file is created with owner-only permissions.
 *
 * SECURITY LIMITATIONS (documented honestly):
 * - The encryption key is derived from the OS username, hostname, and an optional
 *   deployment `appSecret`. There is no hardware-backed or user-entered secret, so
 *   a local process running AS THE SAME USER can recompute the key and decrypt the
 *   file. This fallback therefore protects against OTHER users/processes and at-rest
 *   copying of the file, NOT against a full compromise of the user's own session.
 * - On Windows, POSIX file mode bits (0o600) are only partially enforced; the real
 *   protection is the per-user profile ACL on the app-data directory. We still set
 *   restrictive modes on a best-effort basis.
 * This is strictly a fallback; the OS credential store is preferred (Req 5.8).
 */

import { mkdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { hostname, userInfo, homedir } from "node:os";
import { join } from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

import type { SecretStore, SecretStoreOptions } from "./secret-store";

const ALGORITHM = "aes-256-gcm";
const KEY_LEN = 32; // 256-bit
const IV_LEN = 12; // GCM standard nonce length
const SALT_LEN = 16;
const AUTH_TAG_LEN = 16;
const FILE_MAGIC = "cfls-secret-v1";

/** On-disk envelope for one encrypted secret. All binary fields are base64. */
interface EncryptedRecord {
  magic: string;
  salt: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

/**
 * Resolve the default per-user directory for the encrypted-file fallback.
 * Prefers Windows `%APPDATA%`, then XDG/`HOME`-based locations.
 */
export function resolveDefaultFileStoreDir(): string {
  const appData = process.env["APPDATA"];
  if (appData && appData.length > 0) {
    return join(appData, "cfls", "secrets");
  }
  const xdg = process.env["XDG_DATA_HOME"];
  if (xdg && xdg.length > 0) {
    return join(xdg, "cfls", "secrets");
  }
  return join(homedir(), ".cfls", "secrets");
}

/**
 * Derive the per-user/host passphrase. Kept out of logs; only ever used as
 * scrypt input. The `appSecret` (if provided) adds deployment-scoped entropy.
 */
function derivePassphrase(appSecret: string | undefined): string {
  let username = "unknown-user";
  try {
    username = userInfo().username || username;
  } catch {
    // userInfo can throw on some sandboxed platforms; fall back to a constant.
  }
  const host = safeHostname();
  return ["cfls", username, host, appSecret ?? ""].join("\u0000");
}

function safeHostname(): string {
  try {
    return hostname() || "unknown-host";
  } catch {
    return "unknown-host";
  }
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LEN);
}

function sanitizeName(name: string): string {
  // Constrain the secret name to a safe file basename (defense against traversal).
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (cleaned.length === 0 || cleaned === "." || cleaned === "..") {
    throw new Error("Invalid secret name");
  }
  return `${cleaned}.enc`;
}

/**
 * Create a {@link SecretStore} backed by AES-256-GCM encrypted files on disk.
 */
export function createEncryptedFileStore(
  options: Pick<SecretStoreOptions, "fileStoreDir" | "appSecret"> = {},
): SecretStore {
  const dir = options.fileStoreDir ?? resolveDefaultFileStoreDir();
  const passphrase = derivePassphrase(options.appSecret);

  const filePathFor = (name: string): string => join(dir, sanitizeName(name));

  async function ensureDir(): Promise<void> {
    await mkdir(dir, { recursive: true });
    // Best-effort owner-only directory perms (no-op semantics on some platforms).
    try {
      await chmod(dir, 0o700);
    } catch {
      /* best effort */
    }
  }

  return {
    backend: "encrypted-file",

    async isAvailable(): Promise<boolean> {
      // Available if we can create the directory and perform a round-trip
      // encrypt/decrypt of a probe value without persisting a real secret.
      try {
        await ensureDir();
        const salt = randomBytes(SALT_LEN);
        const key = deriveKey(passphrase, salt);
        const iv = randomBytes(IV_LEN);
        const cipher = createCipheriv(ALGORITHM, key, iv);
        const enc = Buffer.concat([
          cipher.update("probe", "utf8"),
          cipher.final(),
        ]);
        const tag = cipher.getAuthTag();
        const decipher = createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(tag);
        const dec = Buffer.concat([
          decipher.update(enc),
          decipher.final(),
        ]).toString("utf8");
        return dec === "probe";
      } catch {
        return false;
      }
    },

    async get(name: string): Promise<string | null> {
      const path = filePathFor(name);
      if (!existsSync(path)) return null;
      let raw: string;
      try {
        raw = await readFile(path, "utf8");
      } catch {
        return null;
      }
      const record = parseRecord(raw);
      if (record === null) {
        // Corrupt/foreign file — treat as no usable secret rather than leaking details.
        throw new Error("Stored secret is unreadable or corrupt");
      }
      const salt = Buffer.from(record.salt, "base64");
      const iv = Buffer.from(record.iv, "base64");
      const authTag = Buffer.from(record.authTag, "base64");
      const ciphertext = Buffer.from(record.ciphertext, "base64");
      if (authTag.length !== AUTH_TAG_LEN || iv.length !== IV_LEN) {
        throw new Error("Stored secret has invalid parameters");
      }
      const key = deriveKey(passphrase, salt);
      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(authTag);
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      return plaintext.toString("utf8");
    },

    async set(name: string, value: string): Promise<void> {
      await ensureDir();
      const path = filePathFor(name);
      const salt = randomBytes(SALT_LEN);
      const key = deriveKey(passphrase, salt);
      const iv = randomBytes(IV_LEN);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      const ciphertext = Buffer.concat([
        cipher.update(Buffer.from(value, "utf8")),
        cipher.final(),
      ]);
      const authTag = cipher.getAuthTag();
      const record: EncryptedRecord = {
        magic: FILE_MAGIC,
        salt: salt.toString("base64"),
        iv: iv.toString("base64"),
        authTag: authTag.toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      };
      // Write with owner-only permissions; { mode } applies on creation.
      await writeFile(path, JSON.stringify(record), {
        encoding: "utf8",
        mode: 0o600,
      });
      try {
        await chmod(path, 0o600);
      } catch {
        /* best effort on platforms without POSIX modes */
      }
    },

    async delete(name: string): Promise<boolean> {
      const path = filePathFor(name);
      if (!existsSync(path)) return false;
      await rm(path, { force: true });
      return true;
    },
  };
}

function parseRecord(raw: string): EncryptedRecord | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const r = obj as Record<string, unknown>;
  if (
    typeof r["magic"] !== "string" ||
    typeof r["salt"] !== "string" ||
    typeof r["iv"] !== "string" ||
    typeof r["authTag"] !== "string" ||
    typeof r["ciphertext"] !== "string"
  ) {
    return null;
  }
  const magic = Buffer.from(r["magic"]);
  const expected = Buffer.from(FILE_MAGIC);
  if (magic.length !== expected.length || !timingSafeEqual(magic, expected)) {
    return null;
  }
  return {
    magic: r["magic"],
    salt: r["salt"],
    iv: r["iv"],
    authTag: r["authTag"],
    ciphertext: r["ciphertext"],
  };
}
