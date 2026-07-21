/**
 * The always-excluded list (design §7.6; Req 19.7, 29.2).
 *
 * These paths are excluded from watching, analysis, and transmission. Nothing
 * under an excluded directory, and no secret or binary file, is ever read for
 * import specifiers, hashed into a fingerprint, or reflected in a manifest
 * entry. Applying the filter here (rather than at each call site) keeps the
 * guarantee in one auditable place.
 */

import { baseName, extName, segments } from "./internal";
import type { RepoRelativeFile } from "./language-analyzer";

/**
 * Directory names that are excluded wherever they appear in a path: package
 * stores, build outputs, caches, VCS internals, vendored code, and virtual
 * environments (design §7.6).
 */
export const EXCLUDED_DIRECTORIES: ReadonlySet<string> = new Set([
  // Package stores / vendored code.
  "node_modules",
  "vendor",
  "bower_components",
  "jspm_packages",
  // Build outputs.
  "dist",
  "build",
  "out",
  "lib-cov",
  "target",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".output",
  // Caches.
  ".cache",
  ".turbo",
  ".parcel-cache",
  "coverage",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  // VCS internals.
  ".git",
  ".hg",
  ".svn",
  // CFLS local control-plane files can include loopback discovery credentials
  // and encrypted state; they are never source/analyzer inputs or activity.
  ".coordination",
  ".cfls-cache",
  // Virtual environments.
  "venv",
  ".venv",
  "env",
  ".tox",
]);

/**
 * Exact secret file names that are always excluded (design §7.6). Dot-env files
 * and their variants are matched separately by prefix below.
 */
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

/** File extensions for key/cert/secret material that must never be read. */
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

/** Binary/asset extensions excluded from analysis (design §7.6). */
const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  // Images / media.
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".ico",
  ".webp",
  ".svg",
  ".mp3",
  ".mp4",
  ".mov",
  ".avi",
  ".wav",
  // Fonts.
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".otf",
  // Archives / documents.
  ".zip",
  ".tar",
  ".gz",
  ".tgz",
  ".rar",
  ".7z",
  ".pdf",
  // Compiled / native binaries.
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".o",
  ".a",
  ".class",
  ".jar",
  ".wasm",
  ".node",
  ".lockb",
]);

/** Whether a file name is a dot-env file (`.env`, `.env.local`, `.env.prod`, …). */
function isDotEnvFile(name: string): boolean {
  return name === ".env" || name.startsWith(".env.");
}

/**
 * Whether a repository-relative path is always excluded from watching,
 * analysis, and transmission (design §7.6; Req 19.7, 29.2).
 */
export function isExcludedPath(path: string): boolean {
  const parts = segments(path);
  for (const part of parts) {
    if (EXCLUDED_DIRECTORIES.has(part)) return true;
  }

  const name = baseName(path);
  if (isDotEnvFile(name)) return true;
  if (SECRET_FILE_NAMES.has(name)) return true;

  const ext = extName(path);
  if (SECRET_EXTENSIONS.has(ext)) return true;
  if (BINARY_EXTENSIONS.has(ext)) return true;

  return false;
}

/** Drop every {@link RepoRelativeFile} whose path is on the excluded list. */
export function filterIncluded(files: RepoRelativeFile[]): RepoRelativeFile[] {
  return files.filter((file) => !isExcludedPath(file.path));
}
