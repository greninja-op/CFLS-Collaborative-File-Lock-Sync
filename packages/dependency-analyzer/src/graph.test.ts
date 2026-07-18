/**
 * Unit tests for full Dependency_Graph construction and canonical
 * serialize/deserialize (task 5.3; design §7.1, §7.3; Req 19.3, 19.7, 20.4).
 */

import { describe, expect, it } from "vitest";

import type { DependencyGraph, SessionId } from "@cfls/protocol";

import {
  INITIAL_GRAPH_VERSION,
  buildDependencyGraph,
  deserializeGraph,
  normalizeGraph,
  serializeGraph,
} from "./graph";
import type { RepoRelativeFile } from "./language-analyzer";
import { tsJsAnalyzer } from "./ts-js-analyzer";

function file(path: string, content: string): RepoRelativeFile {
  return { path, content };
}

const SESSION: SessionId = {
  repoId: "git@github.com:acme/app.git",
  teamId: "team-1",
  branch: "main",
  baseRevision: "abc123",
};

describe("buildDependencyGraph — five metadata categories", () => {
  it("assembles snapshot, packages, modules, and contracts", () => {
    const files = [
      file(
        "package.json",
        JSON.stringify({ name: "app", dependencies: { react: "^18.0.0" } }),
      ),
      file("package-lock.json", "{}"),
      file("src/a.ts", "import { b } from './b';\nexport const a = 1;"),
      file("src/b.ts", "export const b = 2;"),
    ];

    const graph = buildDependencyGraph(SESSION, files);

    expect(graph.snapshot.sessionId).toEqual(SESSION);
    expect(graph.snapshot.graphVersion).toBe(INITIAL_GRAPH_VERSION);
    expect(graph.snapshot.analyzerVersion).toBe(tsJsAnalyzer.version);

    expect(graph.packages.map((p) => p.manifestPath)).toContain("package.json");
    expect(graph.modules.map((m) => m.sourceFile)).toEqual(["src/a.ts", "src/b.ts"]);

    // a.ts depends on b.ts via a static relative import (high confidence).
    const aModule = graph.modules.find((m) => m.sourceFile === "src/a.ts");
    expect(aModule?.edges).toEqual([
      { from: "src/a.ts", to: "src/b.ts", kind: "runtime_import", confidence: "high" },
    ]);

    expect(graph.contracts.length).toBeGreaterThan(0);
  });

  it("records the analyzer version on the snapshot", () => {
    const graph = buildDependencyGraph(SESSION, [], { graphVersion: 7 });
    expect(graph.snapshot.graphVersion).toBe(7);
    expect(graph.snapshot.analyzerVersion).toBe(tsJsAnalyzer.version);
  });

  it("excludes node_modules, build outputs, and secrets from the graph", () => {
    const files = [
      file("src/app.ts", "import x from './util';"),
      file("src/util.ts", "export const x = 1;"),
      file("node_modules/react/index.js", "export default {};"),
      file("dist/app.js", "export const bundled = 1;"),
      file(".env", "SECRET=shh"),
      file("node_modules/pkg/package.json", JSON.stringify({ dependencies: { evil: "1" } })),
    ];

    const graph = buildDependencyGraph(SESSION, files);
    const sources = graph.modules.map((m) => m.sourceFile);

    expect(sources).toEqual(["src/app.ts", "src/util.ts"]);
    expect(sources.some((s) => s.includes("node_modules"))).toBe(false);
    expect(sources.some((s) => s.startsWith("dist/"))).toBe(false);
    // The excluded manifest never contributes package metadata.
    expect(graph.packages.some((p) => p.manifestPath.includes("node_modules"))).toBe(false);
    // No contract fingerprint references excluded content.
    expect(graph.contracts.some((c) => c.id.includes("node_modules"))).toBe(false);
    expect(graph.contracts.some((c) => c.id === ".env")).toBe(false);
  });
});

describe("serializeGraph / deserializeGraph — round-trip", () => {
  it("round-trips a built graph to an equivalent graph", () => {
    const files = [
      file("package.json", JSON.stringify({ dependencies: { react: "^18" } })),
      file("src/a.ts", "import './b';\nimport type { T } from './types';"),
      file("src/b.ts", "export function b() {}"),
      file("src/types.ts", "export type T = number;"),
    ];
    const graph = buildDependencyGraph(SESSION, files);

    const round = deserializeGraph(serializeGraph(graph));
    expect(round).toEqual(graph);
  });

  it("is order-independent: shuffled inputs serialize identically", () => {
    const a: DependencyGraph = normalizeGraph({
      snapshot: { sessionId: SESSION, graphVersion: 2, analyzerVersion: "1.0.0" },
      packages: [
        {
          manifestPath: "package.json",
          packageManager: "npm",
          directDependencyNames: ["react", "zod"],
          declaredVersionRanges: { zod: "^3", react: "^18" },
          scope: "prod",
          lockfileHash: "hash",
        },
      ],
      modules: [
        {
          sourceFile: "src/a.ts",
          edges: [
            { from: "src/a.ts", to: "src/c.ts", kind: "runtime_import", confidence: "high" },
            { from: "src/a.ts", to: "src/b.ts", kind: "runtime_import", confidence: "high" },
          ],
        },
      ],
      contracts: [
        { id: "src/b.ts", kind: "exported_interface", fingerprint: "f2" },
        { id: "src/a.ts", kind: "public_api", fingerprint: "f1" },
      ],
    });

    // Same data, arrays in a different order and object keys reordered.
    const b: DependencyGraph = {
      contracts: [
        { kind: "public_api", id: "src/a.ts", fingerprint: "f1" },
        { kind: "exported_interface", id: "src/b.ts", fingerprint: "f2" },
      ],
      modules: [
        {
          sourceFile: "src/a.ts",
          edges: [
            { to: "src/b.ts", from: "src/a.ts", confidence: "high", kind: "runtime_import" },
            { to: "src/c.ts", from: "src/a.ts", confidence: "high", kind: "runtime_import" },
          ],
        },
      ],
      packages: [
        {
          scope: "prod",
          manifestPath: "package.json",
          packageManager: "npm",
          directDependencyNames: ["zod", "react"],
          declaredVersionRanges: { react: "^18", zod: "^3" },
          lockfileHash: "hash",
        },
      ],
      snapshot: { analyzerVersion: "1.0.0", graphVersion: 2, sessionId: SESSION },
    };

    expect(serializeGraph(b)).toBe(serializeGraph(a));
    expect(deserializeGraph(serializeGraph(b))).toEqual(a);
  });
});
