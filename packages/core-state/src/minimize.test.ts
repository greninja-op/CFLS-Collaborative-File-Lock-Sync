/**
 * Unit tests for the data-minimization filter and host-side rejection
 * (task 4.24; Req 29.1–29.5; design §7.2, §8.3).
 *
 * Covers:
 *   - detection helpers (absolute paths, secret material),
 *   - inbound rejection with FORMAT_ERROR for source contents, secrets, `.env`
 *     data, absolute/out-of-tree/excluded paths (Req 29.5),
 *   - clean metadata messages passing untouched,
 *   - outbound stripping that leaves only metadata + repo-relative paths and is
 *     idempotent (a stripped message has no remaining violations) (Req 29.3–29.4).
 */

import { describe, expect, it } from "vitest";

import {
  checkInboundMinimization,
  containsSecretMaterial,
  findMinimizationViolations,
  isAbsolutePath,
  minimizeOutbound,
} from "./minimize";

describe("isAbsolutePath", () => {
  it("detects Windows, UNC, POSIX, and home-relative absolute paths", () => {
    expect(isAbsolutePath("C:\\Users\\me\\project")).toBe(true);
    expect(isAbsolutePath("d:/temp/x")).toBe(true);
    expect(isAbsolutePath("\\\\server\\share")).toBe(true);
    expect(isAbsolutePath("/etc/passwd")).toBe(true);
    expect(isAbsolutePath("~/secrets")).toBe(true);
  });

  it("does not flag normalized repository-relative paths", () => {
    expect(isAbsolutePath("src/api/handler.ts")).toBe(false);
    expect(isAbsolutePath("a/b/c.ts")).toBe(false);
    expect(isAbsolutePath("README.md")).toBe(false);
  });
});

describe("containsSecretMaterial", () => {
  it("detects PEM key/cert blocks", () => {
    expect(
      containsSecretMaterial("-----BEGIN RSA PRIVATE KEY-----\nMIIB...\n"),
    ).toBe(true);
    expect(containsSecretMaterial("-----BEGIN CERTIFICATE-----")).toBe(true);
  });

  it("detects .env / config-style secret assignments", () => {
    expect(containsSecretMaterial("API_KEY=sk_live_abc123")).toBe(true);
    expect(containsSecretMaterial("password: hunter2")).toBe(true);
    expect(containsSecretMaterial("AUTH_TOKEN = ghp_xxx")).toBe(true);
  });

  it("does not flag ordinary metadata text", () => {
    expect(containsSecretMaterial("Refactoring the auth handler")).toBe(false);
    expect(containsSecretMaterial("src/api/handler.ts")).toBe(false);
  });
});

describe("findMinimizationViolations — inbound inspection (Req 29.1, 29.2)", () => {
  it("passes a clean, metadata-only coordination message", () => {
    const msg = {
      type: "lock.acquire",
      version: 1,
      eventId: "evt-1",
      deviceId: "device-abc",
      payload: { scope: "src/api/handler.ts", mode: "hard" },
      replay: { counter: 7, nonce: "Zm9vYmFy" },
      signature: "/AbC+dEf0123==",
    };
    expect(findMinimizationViolations(msg)).toEqual([]);
  });

  it("flags a source-content field (Req 29.1)", () => {
    const v = findMinimizationViolations({
      payload: { path: "src/a.ts", content: "const secret = 1;" },
    });
    expect(v).toHaveLength(1);
    expect(v[0]!.kind).toBe("source-content");
  });

  it("flags a secret-bearing field name (Req 29.1)", () => {
    const v = findMinimizationViolations({ apiKey: "sk_live_123" });
    expect(v[0]!.kind).toBe("secret");
  });

  it("flags .env content embedded in a string value (Req 29.1)", () => {
    const v = findMinimizationViolations({
      note: "DATABASE_PASSWORD=hunter2",
    });
    expect(v[0]!.kind).toBe("secret");
  });

  it("flags an absolute filesystem path (Req 29.2)", () => {
    const v = findMinimizationViolations({
      payload: { path: "C:\\Users\\me\\project\\src\\a.ts" },
    });
    expect(v[0]!.kind).toBe("absolute-path");
  });

  it("flags an out-of-tree path (Req 29.2)", () => {
    const v = findMinimizationViolations({ payload: { path: "../../etc/x" } });
    expect(v[0]!.kind).toBe("out-of-tree-path");
  });

  it("flags an excluded path such as node_modules or .env (Req 29.2)", () => {
    expect(
      findMinimizationViolations({ path: "node_modules/react/index.js" })[0]!
        .kind,
    ).toBe("excluded-path");
    expect(findMinimizationViolations({ path: ".env.local" })[0]!.kind).toBe(
      "excluded-path",
    );
    expect(
      findMinimizationViolations({ path: "certs/server.pem" })[0]!.kind,
    ).toBe("excluded-path");
    expect(
      findMinimizationViolations({ path: ".coordination/local-api.json" })[0]!
        .kind,
    ).toBe("excluded-path");
  });

  it("does not misread a base64 signature/nonce starting with '/' as a path", () => {
    const v = findMinimizationViolations({
      signature: "/oQ2b3c4d5e6f7g8h9==",
      replay: { counter: 1, nonce: "/abc+def/ghi==" },
    });
    expect(v).toEqual([]);
  });
});

describe("checkInboundMinimization — host-side rejection (Req 29.5)", () => {
  it("accepts a clean message", () => {
    const result = checkInboundMinimization({
      payload: { scope: "src/a.ts", mode: "soft" },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a message carrying source contents with FORMAT_ERROR", () => {
    const result = checkInboundMinimization({
      eventId: "evt-42",
      payload: { fileContents: "export const x = 1;" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("FORMAT_ERROR");
      expect(result.error.refEventId).toBe("evt-42");
      expect(result.violations.length).toBeGreaterThan(0);
    }
  });

  it("rejects a message carrying a secret with FORMAT_ERROR", () => {
    const result = checkInboundMinimization({ token: "ghp_secret" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("FORMAT_ERROR");
    }
  });
});

describe("minimizeOutbound — pre-transmission filter (Req 29.3, 29.4)", () => {
  it("drops source-content and secret fields, keeping metadata", () => {
    const cleaned = minimizeOutbound({
      type: "presence.editing",
      payload: {
        path: "src/a.ts",
        content: "const x = 1;",
        apiKey: "sk_live_1",
      },
    });
    expect(cleaned).toEqual({
      type: "presence.editing",
      payload: { path: "src/a.ts" },
    });
  });

  it("removes absolute, out-of-tree, and excluded path values", () => {
    const cleaned = minimizeOutbound({
      abs: "/etc/passwd",
      outside: "../../secret",
      excluded: "node_modules/x.js",
      keep: "src/a.ts",
    });
    expect(cleaned).toEqual({ keep: "src/a.ts" });
  });

  it("filters violating elements out of arrays", () => {
    const cleaned = minimizeOutbound({
      paths: ["src/a.ts", "/abs/b.ts", "node_modules/c.js", "src/d.ts"],
    });
    expect(cleaned).toEqual({ paths: ["src/a.ts", "src/d.ts"] });
  });

  it("preserves opaque signature/nonce values verbatim", () => {
    const msg = {
      signature: "/AbC+dEf==",
      replay: { counter: 3, nonce: "/xyz+123==" },
      payload: { path: "src/a.ts" },
    };
    expect(minimizeOutbound(msg)).toEqual(msg);
  });

  it("is idempotent: a stripped message has no remaining violations", () => {
    const dirty = {
      payload: {
        path: "src/a.ts",
        content: "leak",
        password: "hunter2",
        note: "API_KEY=abc",
        abs: "C:\\x\\y",
        list: ["ok/z.ts", "../up"],
      },
    };
    const cleaned = minimizeOutbound(dirty);
    expect(findMinimizationViolations(cleaned)).toEqual([]);
  });
});
