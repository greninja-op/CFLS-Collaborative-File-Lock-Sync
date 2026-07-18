/**
 * Canonical repository ID derivation (Req 10.1; design §9.1).
 *
 * A `Repository_Session` is scoped by a **canonical repository ID** derived from
 * the origin remote URL. The same repository is commonly referenced through
 * several transport-specific spellings — an SSH scp-style remote, an `ssh://`
 * URL, and one or more HTTPS URLs, each optionally suffixed with `.git` and/or a
 * trailing slash:
 *
 * ```
 * git@github.com:acme/app.git      ─┐
 * https://github.com/acme/app.git   ┼─►  "github.com/acme/app"
 * https://github.com/acme/app      ─┘
 * ```
 *
 * {@link deriveRepoId} collapses those variants to one identifier by:
 *   - stripping the transport scheme (`https://`, `http://`, `ssh://`, `git://`, …),
 *   - stripping any `user@` / `user:pass@` credential prefix,
 *   - stripping an explicit `:port`,
 *   - **lowercasing the host** (hosts are case-insensitive),
 *   - stripping a trailing `.git` suffix and any leading/trailing `/`.
 *
 * The result is transport-independent (Property 12): SSH, HTTPS, and `.git`
 * variants that denote the same repository yield an identical ID. The path
 * portion keeps its original case, matching the design's "lowercase host" rule —
 * only the host is case-folded.
 */

/** Raw Ed25519-independent split of a remote into its host and path parts. */
interface RemoteParts {
  /** The host portion (already stripped of credentials and port), possibly empty. */
  host: string;
  /** The repository path portion (leading/trailing slashes not yet stripped). */
  path: string;
}

/** Match a URL scheme prefix such as `https://`, `ssh://`, or `git://`. */
const SCHEME_PREFIX = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.*)$/;

/** Match an scp-style SSH remote: `[user@]host:path` (no `://`). */
const SCP_LIKE = /^(?:[^@/]+@)?([^/:]+):(.*)$/;

/** Match a trailing `:<digits>` port on a host component. */
const HOST_PORT = /^(.+):(\d+)$/;

/**
 * Derive the canonical repository ID from an origin remote URL (Req 10.1).
 *
 * Accepts SSH scp-style remotes (`git@host:org/repo.git`), scheme URLs
 * (`https://`, `http://`, `ssh://`, `git://`, …, optionally with credentials and
 * port), and already-canonical `host/path` strings. Throws on an empty remote.
 */
export function deriveRepoId(remote: string): string {
  const trimmed = remote.trim();
  if (trimmed === "") {
    throw new Error("Cannot derive a repository ID from an empty remote.");
  }

  const { host, path } = splitRemote(trimmed);
  const normalizedHost = host.toLowerCase();
  const normalizedPath = stripGitSuffix(trimSlashes(path));

  if (normalizedHost === "") {
    return normalizedPath;
  }
  if (normalizedPath === "") {
    return normalizedHost;
  }
  return `${normalizedHost}/${normalizedPath}`;
}

/** Split a remote into host + path, handling scheme URLs and scp-style remotes. */
function splitRemote(remote: string): RemoteParts {
  const scheme = SCHEME_PREFIX.exec(remote);
  if (scheme !== null) {
    let rest = scheme[2] ?? "";

    // Strip a `user@` / `user:pass@` credential prefix that precedes the host.
    const atIndex = rest.indexOf("@");
    const firstSlashBeforeAt = rest.indexOf("/");
    if (atIndex !== -1 && (firstSlashBeforeAt === -1 || atIndex < firstSlashBeforeAt)) {
      rest = rest.slice(atIndex + 1);
    }

    const slashIndex = rest.indexOf("/");
    const hostPort = slashIndex === -1 ? rest : rest.slice(0, slashIndex);
    const path = slashIndex === -1 ? "" : rest.slice(slashIndex + 1);
    return { host: stripPort(hostPort), path };
  }

  // scp-style `[user@]host:path`. The colon separates host from path, so it is
  // NOT a port and must not be stripped as one.
  const scp = SCP_LIKE.exec(remote);
  if (scp !== null) {
    return { host: scp[1] ?? "", path: scp[2] ?? "" };
  }

  // Already a bare `host/path` (or a local path): treat the first segment as the
  // host only when a separator is present; otherwise it is a path-only value.
  const slashIndex = remote.indexOf("/");
  if (slashIndex === -1) {
    return { host: "", path: remote };
  }
  return {
    host: stripPort(remote.slice(0, slashIndex)),
    path: remote.slice(slashIndex + 1),
  };
}

/** Remove a trailing `:<port>` from a host component, if present. */
function stripPort(hostPort: string): string {
  const match = HOST_PORT.exec(hostPort);
  return match !== null ? (match[1] ?? hostPort) : hostPort;
}

/** Strip leading and trailing `/` characters from a path. */
function trimSlashes(path: string): string {
  return path.replace(/^\/+/, "").replace(/\/+$/, "");
}

/** Strip a single trailing `.git` suffix (case-insensitive) from a repo path. */
function stripGitSuffix(path: string): string {
  return path.replace(/\.git$/i, "");
}
