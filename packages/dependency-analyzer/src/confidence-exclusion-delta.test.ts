/**
 * Focused unit tests for task 5.5 — confidence levels, the always-excluded
 * list, and add/remove edge deltas (Req 19.6, 19.7, 19.4; design §7.3–§7.6).
 *
 * These complement (and deliberately do not duplicate) the broader coverage in
 * `ts-js-analyzer.test.ts`, `exclusion.test.ts`, `delta.test.ts`, and
 * `graph.test.ts`. They pin down the gaps those suites leave open:
 *
 *   - Req 19.6: the full confidence matrix, including the untested
 *     dynamic-import-of-an-alias → `low` case.
 *   - Req 19.7: that every category the requirement names (node_modules, build
 *     outputs, caches, `.git`, vendor, venv, secrets) is dropped by
 *     `filterIncluded`, and that an excluded file's body is never read by the
 *     analyzer pipeline.
 *   - Req 19.4: a single delta that both adds and removes edges at once.
 */

import type { Confidence, DependencyEdge, SessionId } from "@cfls/protocol";
import { describe, expect, it } from "vitest";

import { computeDelta } from "./delta";
import { filterIncluded, isExcludedPath } from "./exclusion";
import { buildDependencyGraph } from "./graph";
import type { RepoRelativeFile } from "./language-analyzer";
import { DYNAMIC_TARGET, TsJsImportAnalyzer } from "./ts-js-analyzer";

const analyzer = new TsJsImportAnalyzer();

function file(path: string, content: string): RepoRelativeFile {
  return { path, content };
}

/** The single edge produced for `src/a.ts` from a one-import fixture. */
function soleEdge(
  content: string,
  extra: RepoRelativeFile[] = [],
): DependencyEdge {
  const { modules } = analyzer.analyze([file("src/a.ts", content), ...extra]);
  const edges = modules.find((m) => m.sourceFile === "src/a.ts")?.edges ?? [];
  expect(edges).toHaveLength(1);
  return edges[0]!;
}

// ---------------------------------------------------------------------------
// Req 19.6 — confidence matrix (static→high / aliased→medium / dynamic→low|unknown)
// ---------------------------------------------------------------------------

describe("Req 19.6 — confidence assignment matrix", () => {
  it("maps each import form to its documented confidence level", () => {
    const cases: {
      label: string;
      edge: DependencyEdge;
      expected: Confidence;
    }[] = [
      {
        label: "static relative import",
        edge: soleEdge("import { b } from './b';", [file("src/b.ts", "")]),
        expected: "high",
      },
      {
        label: "static require() of a relative module",
        edge: soleEdge("const b = require('./b');", [file("src/b.ts", "")]),
        expected: "high",
      },
      {
        label: "aliased (config-resolved) import",
        edge: soleEdge("import { x } from '@/utils';"),
        expected: "medium",
      },
      {
        label: "dynamic import with a static relative string",
        edge: soleEdge("const m = await import('./b');", [
          file("src/b.ts", ""),
        ]),
        expected: "low",
      },
      {
        label: "dynamic import with a non-literal argument",
        edge: soleEdge("const m = await import(pick());"),
        expected: "unknown",
      },
    ];

    for (const { label, edge, expected } of cases) {
      expect(edge.confidence, label).toBe(expected);
    }
  });

  it("downgrades a dynamic import of an aliased specifier to low (§7.5)", () => {
    // Alias specifiers are normally `medium`; a dynamic import of one drops to
    // `low` because the module is loaded reflectively at runtime.
    const edge = soleEdge("const m = await import('@/plugins/loader');");
    expect(edge).toEqual({
      from: "src/a.ts",
      to: "@/plugins/loader",
      kind: "dynamic_unknown",
      confidence: "low",
    });
  });

  it("keeps a non-literal dynamic import pointed at the dynamic sentinel", () => {
    const edge = soleEdge("await import(`./locales/${lang}`);");
    expect(edge.to).toBe(DYNAMIC_TARGET);
    expect(edge.confidence).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// Req 19.7 — the always-excluded list is never analyzed
// ---------------------------------------------------------------------------

describe("Req 19.7 — excluded folders and files are never analyzed", () => {
  it("drops every category the requirement names via filterIncluded", () => {
    const kept = file("src/keep.ts", "export const keep = 1;");
    const excluded: RepoRelativeFile[] = [
      file("node_modules/react/index.js", "module.exports = {};"),
      file("packages/app/node_modules/x/y.ts", "export const y = 1;"),
      file("dist/bundle.js", "export const bundled = 1;"),
      file("build/main.js", "export const built = 1;"),
      file(".cache/data.json", "{}"),
      file("coverage/lcov.info", "TN:"),
      file(".git/config", "[core]"),
      file("vendor/lib.go", "package main"),
      file("venv/lib/site.py", "import os"),
      file(".venv/pyvenv.cfg", "home = /usr"),
      file("secrets/id_rsa", "PRIVATE KEY"),
      file("config/.env.production", "TOKEN=shh"),
      file("certs/server.pem", "-----BEGIN CERTIFICATE-----"),
    ];

    // Each excluded path is individually recognized as excluded.
    for (const f of excluded) {
      expect(isExcludedPath(f.path), f.path).toBe(true);
    }

    // filterIncluded keeps only the ordinary source file.
    expect(filterIncluded([kept, ...excluded])).toEqual([kept]);
  });

  it("never reads an excluded file's body when building the graph", () => {
    const session: SessionId = {
      repoId: "git@github.com:acme/app.git",
      teamId: "team-1",
      branch: "main",
      baseRevision: "abc123",
    };
    const files: RepoRelativeFile[] = [
      file("src/app.ts", "import './util';"),
      file("src/util.ts", "export const util = 1;"),
      // Excluded content laced with markers that must never surface anywhere.
      file("node_modules/evil/index.js", "const LEAK_A = 'node-modules-leak';"),
      file("dist/app.js", "const LEAK_B = 'build-output-leak';"),
      file(".env", "SECRET_TOKEN=env-secret-leak"),
      file("vendor/lib.js", "export const LEAK_C = 'vendor-leak';"),
    ];

    const graph = buildDependencyGraph(session, files);
    const serialized = JSON.stringify(graph);

    // No excluded path appears as a source, package, or contract id...
    expect(graph.modules.map((m) => m.sourceFile)).toEqual([
      "src/app.ts",
      "src/util.ts",
    ]);
    for (const marker of [
      "node_modules",
      "dist/",
      "vendor/",
      ".env",
      "node-modules-leak",
      "build-output-leak",
      "env-secret-leak",
      "vendor-leak",
      "SECRET_TOKEN",
    ]) {
      expect(serialized.includes(marker), `must not leak "${marker}"`).toBe(
        false,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Req 19.4 — add/remove edge deltas
// ---------------------------------------------------------------------------

describe("Req 19.4 — add and remove edge deltas", () => {
  const session: SessionId = {
    repoId: "git@github.com:acme/app.git",
    teamId: "team-1",
    branch: "main",
    baseRevision: "abc123",
  };

  function graph(files: RepoRelativeFile[], graphVersion: number) {
    return buildDependencyGraph(session, files, { graphVersion });
  }

  it("captures an add and a remove within a single delta", () => {
    // a.ts switches its dependency from b.ts to c.ts: one edge removed, one added.
    const before = graph(
      [
        file("src/a.ts", "import './b';"),
        file("src/b.ts", "export const b = 1;"),
        file("src/c.ts", "export const c = 2;"),
      ],
      1,
    );
    const after = graph(
      [
        file("src/a.ts", "import './c';"),
        file("src/b.ts", "export const b = 1;"),
        file("src/c.ts", "export const c = 2;"),
      ],
      2,
    );

    const delta = computeDelta(before, after);
    const ops = delta.changedEdges.map((e) => ({ to: e.to, op: e.op }));

    expect(ops).toContainEqual({ to: "src/c.ts", op: "add" });
    expect(ops).toContainEqual({ to: "src/b.ts", op: "remove" });
    expect(delta.changedEdges).toHaveLength(2);
  });

  it("orders changed edges deterministically regardless of scan order", () => {
    const before = graph([file("src/a.ts", "export const a = 1;")], 1);
    const after = graph(
      [
        file("src/a.ts", "import './m';\nimport './z';\nimport './b';"),
        file("src/b.ts", ""),
        file("src/m.ts", ""),
        file("src/z.ts", ""),
      ],
      2,
    );

    const delta = computeDelta(before, after);
    const targets = delta.changedEdges.map((e) => e.to);
    expect(targets).toEqual([...targets].sort((x, y) => x.localeCompare(y)));
    expect(delta.changedEdges.every((e) => e.op === "add")).toBe(true);
  });

  it("treats a confidence change as a remove + add pair", () => {
    // Same target, different confidence (static→dynamic) is a distinct edge.
    const before = graph(
      [file("src/a.ts", "import './b';"), file("src/b.ts", "")],
      1,
    );
    const after = graph(
      [file("src/a.ts", "await import('./b');"), file("src/b.ts", "")],
      2,
    );

    const delta = computeDelta(before, after);
    const highRemoved = delta.changedEdges.find(
      (e) =>
        e.to === "src/b.ts" && e.confidence === "high" && e.op === "remove",
    );
    const lowAdded = delta.changedEdges.find(
      (e) => e.to === "src/b.ts" && e.confidence === "low" && e.op === "add",
    );
    expect(highRemoved).toBeDefined();
    expect(lowAdded).toBeDefined();
  });
});
