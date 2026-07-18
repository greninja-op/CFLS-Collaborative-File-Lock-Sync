/**
 * Internal path- and source-text helpers shared by the analyzers, manifest
 * reader, and contract fingerprinter.
 *
 * All paths handled here are repository-relative and forward-slash normalized
 * (design §7.2, §9.3). Nothing in this module reads the filesystem — callers
 * pass in-memory {@link RepoRelativeFile}s only.
 */

/** The directory portion of a forward-slash path (`""` for a top-level file). */
export function dirOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

/** The final path segment (file name) of a forward-slash path. */
export function baseName(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

/** The lower-cased extension including the dot (e.g. `.ts`), or `""`. */
export function extName(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

/** Split a path into its non-empty segments. */
export function segments(path: string): string[] {
  return path.split("/").filter((s) => s !== "");
}

/** Collapse `.` / `..` segments in a forward-slash path. */
export function normalizePath(path: string): string {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else out.push("..");
      continue;
    }
    out.push(segment);
  }
  return out.join("/");
}

/**
 * Remove block and line comments so commented-out declarations/imports are
 * ignored. Kept intentionally simple: it does not track string state, which is
 * acceptable because we only ever scan for structural keywords afterwards.
 */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
