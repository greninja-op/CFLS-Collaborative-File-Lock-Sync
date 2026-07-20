/**
 * Property 12 — Canonical repository ID is transport-independent.
 *
 * **Validates: Requirements 10.1**
 *
 * A `Repository_Session` is scoped by a canonical repository ID derived from the
 * origin remote URL (Req 10.1; design §9.1). The same repository is referenced
 * through many transport-specific spellings — SSH scp-style, `ssh://`/`git://`
 * URLs, and HTTPS URLs, each optionally suffixed with `.git` and/or a trailing
 * slash, and optionally carrying a `user@` credential. This property asserts that
 * every such variant that denotes the *same* repository collapses to one
 * identical canonical `repoId` (Property 12).
 *
 * The test generates a random host/org/repo, builds the full family of transport
 * variants, and asserts {@link deriveRepoId} returns the same value for all of
 * them (equal to the expected `host/org/repo` canonical form).
 */

import { assertProperty, fc, propertyTag } from "@cfls/test-utils";
import { describe, expect, it } from "vitest";

import { deriveRepoId } from "./repo-id";

/** Characters allowed in an org/repo path segment (no `/`, `:`, `@`, `.`). */
const SEGMENT_CHARS =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_".split("");

/** Characters allowed in a single host label (lowercase host, DNS-like). */
const HOST_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789".split("");

/**
 * A single path segment (an org or repo name): 1–12 chars from a safe alphabet
 * that cannot introduce a separator, a scheme, a credential, or a `.git` suffix.
 */
const segment = fc
  .array(fc.constantFrom(...SEGMENT_CHARS), { minLength: 1, maxLength: 12 })
  .map((chars) => chars.join(""));

/** A dotted, lowercase host such as `github.com` or `git.internal.example`. */
const host = fc
  .array(
    fc
      .array(fc.constantFrom(...HOST_CHARS), { minLength: 1, maxLength: 8 })
      .map((chars) => chars.join("")),
    { minLength: 1, maxLength: 3 },
  )
  .map((labels) => labels.join("."));

describe(
  propertyTag(12, "Canonical repository ID is transport-independent"),
  () => {
    it("derives an identical canonical repoId for SSH, HTTPS, and .git remote variants", () => {
      assertProperty(
        fc.property(host, segment, segment, (h, org, repo) => {
          // The transport-independent canonical form: lowercase host + repo path.
          const expected = `${h}/${org}/${repo}`;

          // Every spelling below denotes the SAME repository and must collapse to
          // `expected`: scp-style SSH, ssh://, git://, and HTTPS — each with and
          // without a `.git` suffix, a trailing slash, and a credential prefix.
          const variants = [
            `git@${h}:${org}/${repo}.git`,
            `git@${h}:${org}/${repo}`,
            `ssh://git@${h}/${org}/${repo}.git`,
            `ssh://git@${h}/${org}/${repo}`,
            `git://${h}/${org}/${repo}.git`,
            `https://${h}/${org}/${repo}.git`,
            `https://${h}/${org}/${repo}`,
            `https://${h}/${org}/${repo}/`,
            `https://${h}/${org}/${repo}.git/`,
            `http://${h}/${org}/${repo}.git`,
            `https://user@${h}/${org}/${repo}.git`,
          ];

          for (const remote of variants) {
            expect(deriveRepoId(remote)).toBe(expected);
          }
        }),
      );
    });
  },
);
