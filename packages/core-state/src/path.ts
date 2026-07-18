/**
 * Repository-relative path normalization (Req 10.3–10.4; design §9.3).
 *
 * Coordination keys every lock, presence, and intent by a repository-relative
 * path. The same file is often referred to by several equivalent spellings that
 * differ only by:
 *   - separator style (`\` on Windows vs `/` elsewhere),
 *   - a leading `./`,
 *   - redundant `.` segments or empty segments (`a//b`),
 *   - `..` segments that resolve back within the tree,
 *   - and, on case-insensitive platforms, letter case.
 *
 * {@link normalizePath} maps all of those to a single canonical spelling so a
 * file is never treated as two distinct paths (Property 11):
 *   - convert `\` separators to `/`,
 *   - drop empty and `.` segments,
 *   - resolve `..` against the accumulated result,
 *   - express the path relative to the repository root (no leading `/`).
 *
 * Case-sensitivity (Req 10.4) is handled separately from the stored spelling: we
 * keep the original case in the normalized path and expose {@link pathMatchKey}
 * to derive a platform-aware **matching key** (case-folded on case-insensitive
 * platforms such as Windows/macOS, preserved on case-sensitive platforms such as
 * Linux). This lets callers display the original path while matching two paths
 * that differ only by case as one.
 */

/** Whether a platform treats repository-relative paths as case-sensitive. */
export type PlatformCaseSensitivity = "case-sensitive" | "case-insensitive";

/**
 * Determine the default case-sensitivity for a platform id (Req 10.4). Windows
 * (`win32`) and macOS (`darwin`) filesystems are treated as case-insensitive;
 * everything else (Linux and friends) as case-sensitive. Accepts a `platform`
 * string (defaults to the current process platform) so callers and tests can be
 * explicit.
 */
export function defaultCaseSensitivity(
  platform: string = process.platform,
): PlatformCaseSensitivity {
  return platform === "win32" || platform === "darwin"
    ? "case-insensitive"
    : "case-sensitive";
}

/**
 * Normalize a repository-relative path to its canonical spelling (Req 10.3).
 *
 * Separators are unified to `/`, `.`/empty segments are dropped, `..` segments
 * are resolved, and the result is expressed relative to the repository root.
 * Case is preserved — use {@link pathMatchKey} for platform-aware matching.
 * `..` segments that would escape the repository root are retained as leading
 * `..` segments (an out-of-tree path), keeping the mapping deterministic.
 */
export function normalizePath(rawPath: string): string {
  const unified = rawPath.replace(/\\/g, "/");
  const segments = unified.split("/");
  const resolved: string[] = [];

  for (const segment of segments) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      const top = resolved[resolved.length - 1];
      if (resolved.length > 0 && top !== "..") {
        resolved.pop();
      } else {
        resolved.push("..");
      }
      continue;
    }
    resolved.push(segment);
  }

  return resolved.join("/");
}

/**
 * Derive the platform-aware matching key for an already-normalized path
 * (Req 10.4). On case-insensitive platforms the key is lower-cased so two paths
 * differing only by case collapse to one; on case-sensitive platforms the path
 * is returned unchanged.
 */
export function pathMatchKey(
  normalizedPath: string,
  sensitivity: PlatformCaseSensitivity = defaultCaseSensitivity(),
): string {
  return sensitivity === "case-insensitive"
    ? normalizedPath.toLowerCase()
    : normalizedPath;
}

/**
 * Convenience: normalize a raw path and immediately derive its platform-aware
 * matching key (Req 10.3–10.4). Equivalent to
 * `pathMatchKey(normalizePath(rawPath), sensitivity)`.
 */
export function normalizePathKey(
  rawPath: string,
  sensitivity: PlatformCaseSensitivity = defaultCaseSensitivity(),
): string {
  return pathMatchKey(normalizePath(rawPath), sensitivity);
}
