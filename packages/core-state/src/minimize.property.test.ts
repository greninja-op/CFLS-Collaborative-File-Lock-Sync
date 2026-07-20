/**
 * Property 9 — Data-minimization invariant.
 *
 * **Validates: Requirements 29.1, 29.2, 29.3, 29.4, 29.5**
 *
 * *For any* agent input — including files and events that carry source-code
 * contents, secrets, `.env` data, or absolute filesystem paths — every message
 * the agent serializes for transmission MUST contain only coordination /
 * Dependency_Graph metadata with normalized repository-relative paths and none
 * of the excluded content, and the host MUST reject any inbound message that
 * violates this (design §7.2, §8.3).
 *
 * This single fast-check property (≥100 iterations) generates arbitrary,
 * deeply-nested message-shaped values whose fields and leaves are drawn from a
 * mix of:
 *   - clean coordination metadata (repo-relative paths, modes, ids, counters),
 *   - source-content / secret field *names* (Req 29.1),
 *   - excluded string *values*: absolute paths, `.env`/PEM secret material,
 *     `node_modules`/build/`.git`/key-file paths, and out-of-tree `..` paths
 *     (Req 29.1–29.2),
 *   - opaque cryptographic material (base64 signatures/nonces that may start
 *     with `/`) placed under opaque field names.
 *
 * It then asserts, for every generated input:
 *   1. the agent-side {@link minimizeOutbound} filter produces a message with
 *      **zero** remaining violations — no source contents, secrets, absolute /
 *      out-of-tree / excluded paths survive (Req 29.1–29.4);
 *   2. every string that survives in the minimized message is metadata-only:
 *      not an absolute path, not secret material, and any path-like value is
 *      repository-relative (never escapes the tree) (Req 29.2, 29.3);
 *   3. the host-side gate {@link checkInboundMinimization} accepts the minimized
 *      output (Req 29.5);
 *   4. the host-side gate rejects the raw input with a `FORMAT_ERROR` **iff**
 *      the input actually carries excluded content — i.e. acceptance is exactly
 *      equivalent to being violation-free (Req 29.5).
 */

import { assertProperty, fc, propertyTag } from "@cfls/test-utils";
import { describe, expect, it } from "vitest";

import {
  checkInboundMinimization,
  containsSecretMaterial,
  findMinimizationViolations,
  isAbsolutePath,
  minimizeOutbound,
} from "./minimize";

/** Clean coordination-metadata field names that must always survive. */
const CLEAN_FIELD_NAMES = [
  "type",
  "version",
  "scope",
  "mode",
  "paths",
  "branch",
  "reason",
  "counter",
  "modifyPaths",
  "createPaths",
  "payload",
  "replay",
  "edges",
] as const;

/** Field names carrying source contents or secrets (Req 29.1). */
const EXCLUDED_FIELD_NAMES = [
  "content",
  "contents",
  "fileContents",
  "source",
  "body",
  "diff",
  "patch",
  "password",
  "apiKey",
  "token",
  "secret",
  "privateKey",
  "credentials",
  "env",
  "dotenv",
] as const;

/** Field names whose base64/id values are opaque and preserved verbatim. */
const OPAQUE_FIELD_NAMES = [
  "signature",
  "nonce",
  "hash",
  "deviceId",
  "eventId",
  "publicKey",
] as const;

/** Clean, normalized repository-relative path values. */
const CLEAN_PATHS = [
  "src/a.ts",
  "src/api/handler.ts",
  "packages/core/index.ts",
  "README.md",
  "a/b/c.ts",
  "test/unit/foo.spec.ts",
] as const;

/** String values carrying excluded content (Req 29.1–29.2). */
const EXCLUDED_VALUES = [
  // Absolute filesystem paths (Req 29.2).
  "C:\\Users\\me\\project\\src\\a.ts",
  "d:/temp/x.ts",
  "\\\\server\\share\\y.ts",
  "/etc/passwd",
  "~/secrets/key",
  // Secret material embedded in a string value (Req 29.1).
  "API_KEY=sk_live_abc123",
  "DATABASE_PASSWORD=hunter2",
  "-----BEGIN RSA PRIVATE KEY-----\nMIIB...\n-----END RSA PRIVATE KEY-----",
  // Always-excluded / out-of-tree paths (Req 29.2).
  "node_modules/react/index.js",
  "dist/bundle.js",
  ".git/config",
  ".env.local",
  "certs/server.pem",
  "../../etc/shadow",
] as const;

/** Opaque base64/id values (some starting with `/`) that must be preserved. */
const OPAQUE_VALUES = [
  "/AbC+dEf0123==",
  "Zm9vYmFy",
  "/abc+def/ghi==",
  "device-abc",
  "evt-42",
] as const;

/** Scalar metadata leaves that are always clean. */
const cleanScalarArb = fc.oneof(
  fc.constantFrom(...CLEAN_PATHS),
  fc.constantFrom(
    "lock.acquire",
    "presence.editing",
    "soft",
    "hard",
    "coordination-required",
  ),
  fc.integer({ min: 0, max: 100_000 }),
  fc.boolean(),
);

/** A leaf value that may be clean metadata or excluded content. */
const mixedLeafArb = fc.oneof(
  { weight: 3, arbitrary: cleanScalarArb },
  { weight: 2, arbitrary: fc.constantFrom(...EXCLUDED_VALUES) },
);

/**
 * Recursively generate an arbitrary *nested* value (objects/arrays/leaves) that
 * may appear inside a message field. Used for field values, not the root.
 */
const nodeArb = fc.letrec((tie) => ({
  node: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    { weight: 4, arbitrary: mixedLeafArb },
    {
      weight: 2,
      arbitrary: fc.array(tie("node") as fc.Arbitrary<unknown>, {
        maxLength: 4,
      }),
    },
    {
      weight: 3,
      arbitrary: fc.dictionary(
        fc.constantFrom(...CLEAN_FIELD_NAMES),
        tie("node") as fc.Arbitrary<unknown>,
        { maxKeys: 4 },
      ),
    },
    // A nested object that additionally may carry excluded-by-name and opaque fields.
    {
      weight: 3,
      arbitrary: fc.record(
        {
          clean: fc.dictionary(
            fc.constantFrom(...CLEAN_FIELD_NAMES),
            tie("node") as fc.Arbitrary<unknown>,
            { maxKeys: 3 },
          ),
          excluded: fc.dictionary(
            fc.constantFrom(...EXCLUDED_FIELD_NAMES),
            tie("node") as fc.Arbitrary<unknown>,
            { maxKeys: 2 },
          ),
          opaque: fc.dictionary(
            fc.constantFrom(...OPAQUE_FIELD_NAMES),
            fc.constantFrom(...OPAQUE_VALUES),
            { maxKeys: 2 },
          ),
        },
        { requiredKeys: [] },
      ),
    },
  ),
})).node;

/**
 * A serialized message the agent would transmit: always a structured record
 * (envelope), never a bare scalar. Its fields mix clean coordination metadata,
 * source-content / secret field names, and opaque cryptographic fields, each
 * holding an arbitrary nested value.
 */
const messageArb: fc.Arbitrary<Record<string, unknown>> = fc.record(
  {
    clean: fc.dictionary(fc.constantFrom(...CLEAN_FIELD_NAMES), nodeArb, {
      maxKeys: 4,
    }),
    excluded: fc.dictionary(fc.constantFrom(...EXCLUDED_FIELD_NAMES), nodeArb, {
      maxKeys: 3,
    }),
    opaque: fc.dictionary(
      fc.constantFrom(...OPAQUE_FIELD_NAMES),
      fc.constantFrom(...OPAQUE_VALUES),
      { maxKeys: 2 },
    ),
  },
  { requiredKeys: [] },
);

/** Case-folded opaque field names, matching the filter's own comparison. */
const OPAQUE_FIELD_KEYS = new Set(
  OPAQUE_FIELD_NAMES.map((n) => n.toLowerCase()),
);

/**
 * Collect every string leaf reachable in a value, honoring the opaque-field
 * exemption (values nested under an opaque field name are cryptographic
 * material, not paths/secrets, and are intentionally preserved verbatim).
 */
function collectNonOpaqueStrings(
  value: unknown,
  opaque: boolean,
  out: string[],
): void {
  if (typeof value === "string") {
    if (!opaque) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const el of value) collectNonOpaqueStrings(el, opaque, out);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      const childOpaque = OPAQUE_FIELD_KEYS.has(key.toLowerCase());
      collectNonOpaqueStrings(child, childOpaque, out);
    }
  }
}

/** Whether a surviving path-like string is repository-relative (within tree). */
function isRepoRelativePath(value: string): boolean {
  if (isAbsolutePath(value)) return false;
  // A normalized repo-relative path never begins by escaping the tree.
  const normalizedFirst = value.replace(/\\/g, "/").split("/")[0];
  return normalizedFirst !== "..";
}

describe(propertyTag(9, "data-minimization invariant"), () => {
  it("strips all excluded content from outbound messages and rejects violating inbound ones", () => {
    assertProperty(
      fc.property(messageArb, (message) => {
        // 1. The agent-side filter yields a message with zero violations
        //    (Req 29.1–29.4): no source contents, secrets, or absolute /
        //    out-of-tree / excluded paths survive.
        const cleaned = minimizeOutbound(message);
        expect(findMinimizationViolations(cleaned)).toEqual([]);

        // 2. Every surviving (non-opaque) string is metadata-only: never an
        //    absolute path, never secret material, and any path-like value is
        //    repository-relative (Req 29.2, 29.3).
        const survivors: string[] = [];
        collectNonOpaqueStrings(cleaned, false, survivors);
        for (const s of survivors) {
          expect(isAbsolutePath(s)).toBe(false);
          expect(containsSecretMaterial(s)).toBe(false);
          expect(isRepoRelativePath(s)).toBe(true);
        }

        // 3. The host accepts the minimized, metadata-only output (Req 29.5).
        expect(checkInboundMinimization(cleaned).ok).toBe(true);

        // 4. The host gate accepts the raw input iff it is violation-free, and
        //    otherwise rejects it with a FORMAT_ERROR (Req 29.5).
        const violations = findMinimizationViolations(message);
        const inbound = checkInboundMinimization(message);
        expect(inbound.ok).toBe(violations.length === 0);
        if (!inbound.ok) {
          expect(inbound.error.code).toBe("FORMAT_ERROR");
          expect(inbound.violations.length).toBeGreaterThan(0);
        }
      }),
    );
  });
});
