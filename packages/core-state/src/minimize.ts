/**
 * Data-minimization filter and host-side rejection (Req 29.1–29.5; design
 * §7.2, §8.3).
 *
 * The coordination protocol is strictly *metadata-only*. An agent must never
 * transmit project source-code contents, `.env` data, secrets (passwords, API
 * keys, tokens, certificates, private keys), absolute local filesystem paths,
 * or anything located outside the Authorized_Folder (`node_modules`, build
 * output, caches, Git internals, virtual environments, …). Only coordination
 * metadata and Dependency_Graph metadata — keyed by **normalized
 * repository-relative paths** — may cross the wire (Req 29.1–29.3).
 *
 * This module owns the pure logic for that guarantee, in two directions:
 *
 *   - {@link minimizeOutbound} is the agent-side pre-transmission filter: it
 *     walks any message value and *drops* every field or array element that
 *     would carry excluded content (Req 29.4). It is defense-in-depth — the
 *     agent normally builds already-clean messages — so it fails safe by
 *     removing offending content even if that leaves a structurally-incomplete
 *     message (better to omit than to leak).
 *
 *   - {@link findMinimizationViolations} / {@link checkInboundMinimization} is
 *     the host-side gate: it inspects an inbound message and rejects any that
 *     carries source contents or secrets with a `FORMAT_ERROR` (Req 29.5),
 *     *before* the event is allowed to touch authoritative state.
 *
 * `@cfls/core-state` is intentionally pure and dependency-free, so this module
 * performs purely structural/heuristic inspection of already-deserialized
 * values (an `unknown`) and never reads files or the network.
 */

import type { ProtocolError } from "@cfls/protocol";

import { normalizePath } from "./path";

/** Why a piece of content violates the data-minimization guarantee (Req 29). */
export type MinimizationViolationKind =
  /** A field whose name indicates it carries source-code contents (Req 29.1). */
  | "source-content"
  /** A field/value carrying a secret: password, key, token, cert (Req 29.1). */
  | "secret"
  /** An absolute local filesystem path (Req 29.2). */
  | "absolute-path"
  /** A path that resolves outside the repository/Authorized_Folder (Req 29.2). */
  | "out-of-tree-path"
  /** A path under an always-excluded location (`node_modules`, `.env`, …) (Req 29.2). */
  | "excluded-path";

/** A single data-minimization violation located within a message (Req 29). */
export interface MinimizationViolation {
  /** Dotted/bracketed location of the offending content within the message. */
  readonly location: string;
  /** The category of excluded content that was found. */
  readonly kind: MinimizationViolationKind;
  /** Human-readable description identifying the offending content. */
  readonly message: string;
}

/**
 * Field names (compared case-insensitively) that carry raw source-code
 * contents and must never be transmitted (Req 29.1). Chosen so they never
 * collide with a legitimate metadata field in the message catalog (which uses
 * `scope`, `mode`, `paths`, `deviceId`, `fromRevision`, `reason`, …).
 */
export const SOURCE_CONTENT_FIELD_NAMES: ReadonlySet<string> = new Set([
  "content",
  "contents",
  "filecontent",
  "filecontents",
  "filebody",
  "filedata",
  "source",
  "sourcecode",
  "body",
  "text",
  "raw",
  "rawtext",
  "snippet",
  "excerpt",
  "diff",
  "patch",
  "blob",
]);

/**
 * Field names (compared case-insensitively) that carry secrets and must never
 * be transmitted (Req 29.1): passwords, API keys, tokens, certificates,
 * private keys, and `.env` data.
 */
export const SECRET_FIELD_NAMES: ReadonlySet<string> = new Set([
  "secret",
  "secrets",
  "password",
  "passwd",
  "pwd",
  "passphrase",
  "token",
  "accesstoken",
  "refreshtoken",
  "authtoken",
  "sessiontoken",
  "apikey",
  "apikeys",
  "apisecret",
  "clientsecret",
  "privatekey",
  "secretkey",
  "accesskey",
  "certificate",
  "cert",
  "credential",
  "credentials",
  "env",
  "dotenv",
  "envvars",
  "envfile",
  "environmentvariables",
]);

/**
 * Field names (compared case-insensitively) whose string values are opaque
 * cryptographic/identifier material (base64 signatures, nonces, hashes, public
 * keys, ids). These are legitimate metadata and are **not** scanned as paths or
 * secrets — base64 can contain `/` or start with `/`, which would otherwise be
 * misread as an absolute path.
 */
export const OPAQUE_FIELD_NAMES: ReadonlySet<string> = new Set([
  "signature",
  "sig",
  "nonce",
  "hash",
  "digest",
  "checksum",
  "mac",
  "salt",
  "iv",
  "fingerprint",
  "publickey",
  "devicekey",
  "devicepublickey",
  "eventid",
  "deviceid",
  "sessionkey",
  "repoid",
]);

/** Windows drive-letter absolute path, e.g. `C:\Users` or `d:/temp`. */
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;
/** POSIX absolute path (a normalized repo-relative path never starts with `/`). */
const POSIX_ABSOLUTE_PATH = /^\//;
/** Home-relative path, e.g. `~/secrets` or `~\secrets`. */
const HOME_RELATIVE_PATH = /^~(?:[\\/]|$)/;

/**
 * Whether `value` is an absolute local filesystem path (Req 29.2): a Windows
 * drive path (`C:\…`), a UNC/extended path (`\\server`, `\\?\…`), a POSIX
 * absolute path (`/etc/…`), or a home-relative path (`~/…`). Normalized
 * repository-relative paths never take any of these forms.
 */
export function isAbsolutePath(value: string): boolean {
  return (
    WINDOWS_DRIVE_PATH.test(value) ||
    value.startsWith("\\\\") ||
    POSIX_ABSOLUTE_PATH.test(value) ||
    HOME_RELATIVE_PATH.test(value)
  );
}

/** A PEM block marker (`-----BEGIN … KEY-----`, certificates, etc.). */
const PEM_MARKER = /-----BEGIN [A-Z0-9 ]+-----/;
/** The secret-indicating keywords shared by both assignment patterns below. */
const SECRET_KEYWORDS =
  "secret|token|password|passwd|passphrase|api[_-]?key|private[_-]?key|access[_-]?key|client[_-]?secret|auth[_-]?token";
/**
 * An env-style secret assignment where the left-hand side is a config key that
 * *contains* a secret keyword surrounded by identifier characters, e.g.
 * `DATABASE_PASSWORD=…`, `API_KEY=…`, `AUTH_TOKEN = …`. The whole-word form
 * below misses these because `_` is itself a word character (so there is no
 * boundary between `DATABASE_` and `PASSWORD`).
 */
const ENV_SECRET_ASSIGNMENT = new RegExp(
  `[A-Za-z0-9_.-]*(?:${SECRET_KEYWORDS})[A-Za-z0-9_.-]*\\s*=\\s*\\S`,
  "i",
);
/**
 * A standalone secret assignment as found in config/JSON/YAML text, e.g.
 * `secret: …`, `password = …`, `private-key: …`. The keyword must be a whole
 * word so ordinary prose is not misread.
 */
const SECRET_ASSIGNMENT = new RegExp(
  `\\b(?:${SECRET_KEYWORDS})\\b\\s*[=:]\\s*\\S`,
  "i",
);

/**
 * Whether a string value carries secret material (Req 29.1): a PEM key/cert
 * block, or a `.env`/config-style secret assignment such as `API_KEY=…` or
 * `DATABASE_PASSWORD=…`.
 */
export function containsSecretMaterial(value: string): boolean {
  return (
    PEM_MARKER.test(value) ||
    ENV_SECRET_ASSIGNMENT.test(value) ||
    SECRET_ASSIGNMENT.test(value)
  );
}

/** Directory names that are always excluded from transmission (design §7.6). */
const EXCLUDED_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules",
  "vendor",
  "bower_components",
  "jspm_packages",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".nuxt",
  ".output",
  ".cache",
  ".turbo",
  ".parcel-cache",
  "coverage",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".git",
  ".hg",
  ".svn",
  "venv",
  ".venv",
  "env",
  ".tox",
]);

/** Exact secret file names that must never be referenced/transmitted. */
const SECRET_FILE_NAMES: ReadonlySet<string> = new Set([
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  ".npmrc",
  ".netrc",
  ".pgpass",
  "credentials",
  "secrets.json",
  "secrets.yaml",
  "secrets.yml",
]);

/** Extensions for key/cert/secret material that must never be transmitted. */
const SECRET_EXTENSIONS: ReadonlySet<string> = new Set([
  ".pem",
  ".key",
  ".crt",
  ".cer",
  ".der",
  ".p12",
  ".pfx",
  ".keystore",
  ".jks",
  ".asc",
  ".gpg",
  ".pgp",
]);

/** Whether a file name is a dot-env file (`.env`, `.env.local`, `.env.prod`). */
function isDotEnvFile(name: string): boolean {
  return name === ".env" || name.startsWith(".env.");
}

/** The last `/`-delimited segment of a normalized path. */
function baseName(normalized: string): string {
  const idx = normalized.lastIndexOf("/");
  return idx === -1 ? normalized : normalized.slice(idx + 1);
}

/** The lower-cased extension (including the dot) of a file name, else `""`. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

/**
 * Whether a string is plausibly a filesystem path worth checking against the
 * excluded/out-of-tree rules: it contains a separator, or is itself a dot-env
 * or known secret file name. Non-path free text (reasons, ids) is skipped so we
 * do not flag an English word that merely happens to equal a directory name.
 */
function looksLikePath(value: string): boolean {
  if (value.includes("/") || value.includes("\\")) return true;
  if (isDotEnvFile(value)) return true;
  if (SECRET_FILE_NAMES.has(value)) return true;
  return SECRET_EXTENSIONS.has(extensionOf(value));
}

/**
 * Classify a *path-like* string against the excluded/out-of-tree rules
 * (Req 29.2). Returns `"out-of-tree-path"` when normalization leaves a leading
 * `..` (the path escapes the repository/Authorized_Folder), `"excluded-path"`
 * when any segment is an always-excluded directory or the file is a
 * secret/dot-env file, else `null`.
 */
function classifyPathString(value: string): MinimizationViolationKind | null {
  const normalized = normalizePath(value);
  if (normalized === "") return null;

  const segments = normalized.split("/");
  if (segments[0] === "..") return "out-of-tree-path";

  for (const segment of segments) {
    if (EXCLUDED_DIRECTORIES.has(segment)) return "excluded-path";
  }

  const name = baseName(normalized);
  if (isDotEnvFile(name) || SECRET_FILE_NAMES.has(name)) return "excluded-path";
  if (SECRET_EXTENSIONS.has(extensionOf(name))) return "excluded-path";

  return null;
}

/**
 * Classify a bare string *value* (not its field name) for excluded content.
 * Order: absolute path → secret material → excluded/out-of-tree path. Returns
 * `null` for a clean value such as a normalized repository-relative path.
 */
function classifyStringValue(value: string): MinimizationViolationKind | null {
  if (isAbsolutePath(value)) return "absolute-path";
  if (containsSecretMaterial(value)) return "secret";
  if (looksLikePath(value)) return classifyPathString(value);
  return null;
}

/** Classify a field *name* for excluded-content categories (Req 29.1). */
function classifyFieldName(key: string): MinimizationViolationKind | null {
  const lower = key.toLowerCase();
  if (SOURCE_CONTENT_FIELD_NAMES.has(lower)) return "source-content";
  if (SECRET_FIELD_NAMES.has(lower)) return "secret";
  return null;
}

/** Human-readable message for a violation of the given kind at `location`. */
function describeViolation(
  kind: MinimizationViolationKind,
  location: string,
): string {
  switch (kind) {
    case "source-content":
      return `field '${location}' may carry source-code contents (Req 29.1)`;
    case "secret":
      return `field/value at '${location}' may carry a secret (Req 29.1)`;
    case "absolute-path":
      return `value at '${location}' is an absolute filesystem path (Req 29.2)`;
    case "out-of-tree-path":
      return `path at '${location}' resolves outside the Authorized_Folder (Req 29.2)`;
    case "excluded-path":
      return `path at '${location}' refers to always-excluded content (Req 29.2)`;
  }
}

/** Extend a location path with an object key. */
function keyLocation(base: string, key: string): string {
  return base === "" ? key : `${base}.${key}`;
}

/** Extend a location path with an array index. */
function indexLocation(base: string, index: number): string {
  return `${base}[${index}]`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recursively collect every data-minimization violation in `value`
 * (Req 29.1–29.2). Field names are checked for source/secret categories; string
 * values are checked for absolute/out-of-tree/excluded paths and secret
 * material; opaque fields (signatures, nonces, ids) are exempt from value
 * scanning. `opaque` marks that the current value sits under an opaque field.
 */
function collect(
  value: unknown,
  location: string,
  opaque: boolean,
  out: MinimizationViolation[],
): void {
  if (typeof value === "string") {
    if (opaque) return;
    const kind = classifyStringValue(value);
    if (kind !== null) {
      out.push({ location, kind, message: describeViolation(kind, location) });
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((element, index) => {
      collect(element, indexLocation(location, index), opaque, out);
    });
    return;
  }

  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      const here = keyLocation(location, key);
      const nameKind = classifyFieldName(key);
      if (nameKind !== null) {
        out.push({
          location: here,
          kind: nameKind,
          message: describeViolation(nameKind, here),
        });
        // The whole subtree is excluded regardless of its contents.
        continue;
      }
      const childOpaque = OPAQUE_FIELD_NAMES.has(key.toLowerCase());
      collect(child, here, childOpaque, out);
    }
  }
}

/**
 * Find every data-minimization violation in a (deserialized) message
 * (Req 29.1–29.2). Returns an empty array for a clean, metadata-only message.
 * Never throws.
 */
export function findMinimizationViolations(
  message: unknown,
): MinimizationViolation[] {
  const out: MinimizationViolation[] = [];
  collect(message, "", false, out);
  return out;
}

/** Result of the host-side data-minimization gate. */
export type MinimizationCheckResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: ProtocolError; readonly violations: readonly MinimizationViolation[] };

/**
 * Host-side gate (Req 29.5): reject any inbound message carrying source
 * contents or secrets with a `FORMAT_ERROR`, before it can touch authoritative
 * state. Returns `{ ok: true }` for a clean message. `refEventId` (when the
 * message is an envelope with a string `eventId`) links the error back to the
 * offending event for traceability.
 */
export function checkInboundMinimization(
  message: unknown,
): MinimizationCheckResult {
  const violations = findMinimizationViolations(message);
  if (violations.length === 0) return { ok: true };

  const first = violations[0]!;
  const refEventId =
    isPlainObject(message) && typeof message.eventId === "string"
      ? message.eventId
      : undefined;

  const error: ProtocolError = {
    code: "FORMAT_ERROR",
    message: `data-minimization violation: ${first.message}`,
    ...(refEventId !== undefined ? { refEventId } : {}),
  };
  return { ok: false, error, violations };
}

/**
 * Recursively strip excluded content from an outbound value (Req 29.4).
 * Object fields whose name indicates source/secret content are dropped
 * entirely; string values that are absolute/out-of-tree/excluded paths or carry
 * secret material are removed (object properties omitted, array elements
 * filtered out). Opaque fields (signatures, nonces, ids) are preserved as-is.
 */
function strip(value: unknown, opaque: boolean): unknown {
  if (Array.isArray(value)) {
    const cleaned: unknown[] = [];
    for (const element of value) {
      if (typeof element === "string") {
        if (opaque || classifyStringValue(element) === null) {
          cleaned.push(element);
        }
        continue;
      }
      cleaned.push(strip(element, opaque));
    }
    return cleaned;
  }

  if (isPlainObject(value)) {
    const cleaned: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      // Drop fields whose name indicates source-code contents or secrets.
      if (classifyFieldName(key) !== null) continue;

      const childOpaque = OPAQUE_FIELD_NAMES.has(key.toLowerCase());
      if (typeof child === "string") {
        if (childOpaque || classifyStringValue(child) === null) {
          cleaned[key] = child;
        }
        continue;
      }
      cleaned[key] = strip(child, childOpaque);
    }
    return cleaned;
  }

  return value;
}

/**
 * Agent-side pre-transmission filter (Req 29.3, 29.4): return a copy of
 * `message` with all excluded content removed so only coordination/
 * Dependency_Graph metadata with normalized repository-relative paths remains.
 * The result always satisfies {@link findMinimizationViolations} (empty). Fails
 * safe: offending content is dropped even if that leaves the message
 * structurally incomplete — never transmit rather than leak.
 */
export function minimizeOutbound<T>(message: T): T {
  return strip(message, false) as T;
}
