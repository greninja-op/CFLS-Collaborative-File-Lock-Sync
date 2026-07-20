/**
 * Local Dependency_Graph construction from the Authorized_Folder (Req 19.1–19.3;
 * design §7.5, §7.6).
 *
 * The CoordinationAgent builds a **metadata-only** Dependency_Graph from the
 * source it can see in the Authorized_Folder and uploads it to the host, which
 * shares it across the session so every agent computes indirect risk against the
 * same graph. Because every teammate has the same checkout (via git), each agent
 * building locally yields the same graph even before the host redistributes one.
 *
 * This module ONLY reads import specifiers via `@cfls/dependency-analyzer`
 * (never emits file bodies) and applies the always-excluded list so
 * `node_modules`, build output, caches, and secrets are never read. It is a thin
 * filesystem adapter over the pure analyzer.
 */

import { readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { normalizePath } from "@cfls/core-state";
import {
  buildDependencyGraph,
  isExcludedPath,
  type RepoRelativeFile,
} from "@cfls/dependency-analyzer";
import type { DependencyGraph, SessionId } from "@cfls/protocol";

/**
 * Upper bound on a single file's size that will be read for import analysis.
 * ponytail: source files are far smaller than this; the cap only guards against
 * reading an accidental large/binary file the extension filter missed.
 */
const MAX_FILE_BYTES = 512 * 1024;

/**
 * Upper bound on the number of files scanned, so a pathological tree cannot make
 * startup graph-building unbounded.
 * ponytail: a real repository's tracked source is well under this; raise it if a
 * genuinely larger monorepo needs full coverage.
 */
const MAX_FILES = 20_000;

/**
 * Collect repository-relative source files under `folder`, reading their text
 * for import analysis. Excluded paths (design §7.6) are skipped entirely — their
 * directories are never descended into and their files are never read.
 */
export function collectSourceFiles(folder: string): RepoRelativeFile[] {
  const root = resolve(folder);
  const files: RepoRelativeFile[] = [];
  if (!existsSync(root)) {
    return files;
  }

  const toRepoRelative = (abs: string): string =>
    normalizePath(relative(root, abs).split(sep).join("/"));

  const walk = (dir: string): void => {
    if (files.length >= MAX_FILES) {
      return;
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) {
        return;
      }
      const abs = resolve(dir, entry.name);
      const rel = relative(root, abs);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        continue; // never escape the Authorized_Folder (Req 2.7)
      }
      const repoRel = toRepoRelative(abs);
      if (repoRel === "" || isExcludedPath(repoRel)) {
        continue; // excluded dir/file: never descend or read (design §7.6)
      }
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        try {
          const st = statSync(abs);
          if (st.size > MAX_FILE_BYTES) {
            continue;
          }
          files.push({ path: repoRel, content: readFileSync(abs, "utf8") });
        } catch {
          // File vanished or is unreadable; skip it.
        }
      }
    }
  };

  walk(root);
  return files;
}

/**
 * Build the metadata-only {@link DependencyGraph} for `session` from the source
 * in `folder` (Req 19.1–19.3). Returns an empty-but-valid graph when the folder
 * has no analyzable source.
 */
export function buildFolderGraph(
  session: SessionId,
  folder: string,
): DependencyGraph {
  return buildDependencyGraph(session, collectSourceFiles(folder));
}
