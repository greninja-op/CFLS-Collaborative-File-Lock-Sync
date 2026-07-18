/**
 * Unit tests for the TS/JS import-graph analyzer (task 5.1).
 *
 * Covers: the `LanguageAnalyzer` contract (`supports`), edge-kind derivation,
 * confidence assignment (high / medium / low / unknown per design §7.5,
 * Req 19.6), relative-path resolution, bare-package exclusion, and the
 * metadata-only guarantee (Req 19.2) that no file body leaks into the output.
 */

import type { DependencyEdge, ModuleDependencyMetadata } from "@cfls/protocol";
import { describe, expect, it } from "vitest";

import type { RepoRelativeFile } from "./language-analyzer";
import { DYNAMIC_TARGET, TsJsImportAnalyzer } from "./ts-js-analyzer";

const analyzer = new TsJsImportAnalyzer();

function file(path: string, content: string): RepoRelativeFile {
  return { path, content };
}

function edgesOf(
  modules: ModuleDependencyMetadata[],
  sourceFile: string,
): DependencyEdge[] {
  return modules.find((m) => m.sourceFile === sourceFile)?.edges ?? [];
}

describe("TsJsImportAnalyzer — supports()", () => {
  it("supports TS/JS family extensions", () => {
    for (const path of [
      "src/a.ts",
      "src/b.tsx",
      "src/c.mts",
      "src/d.cts",
      "src/e.js",
      "src/f.jsx",
      "src/g.mjs",
      "src/h.cjs",
    ]) {
      expect(analyzer.supports(path)).toBe(true);
    }
  });

  it("rejects non-source extensions", () => {
    for (const path of ["README.md", "data.json", "styles.css", "img.png"]) {
      expect(analyzer.supports(path)).toBe(false);
    }
  });

  it("exposes a language and analyzer version (design §7.7)", () => {
    expect(analyzer.language).toBe("typescript-javascript");
    expect(analyzer.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("TsJsImportAnalyzer — static relative imports → high", () => {
  it("resolves a relative import to a known file with high confidence", () => {
    const { modules } = analyzer.analyze([
      file("src/a.ts", "import { b } from './b';"),
      file("src/b.ts", "export const b = 1;"),
    ]);
    expect(edgesOf(modules, "src/a.ts")).toEqual([
      { from: "src/a.ts", to: "src/b.ts", kind: "runtime_import", confidence: "high" },
    ]);
  });

  it("resolves parent-directory and index specifiers", () => {
    const { modules } = analyzer.analyze([
      file("src/feature/x.ts", "import '../util';\nimport './nested';"),
      file("src/util.ts", ""),
      file("src/feature/nested/index.ts", ""),
    ]);
    const edges = edgesOf(modules, "src/feature/x.ts");
    expect(edges).toContainEqual({
      from: "src/feature/x.ts",
      to: "src/util.ts",
      kind: "runtime_import",
      confidence: "high",
    });
    expect(edges).toContainEqual({
      from: "src/feature/x.ts",
      to: "src/feature/nested/index.ts",
      kind: "runtime_import",
      confidence: "high",
    });
  });

  it("records re-exports (export ... from) as edges", () => {
    const { modules } = analyzer.analyze([
      file("src/index.ts", "export * from './b';"),
      file("src/b.ts", ""),
    ]);
    expect(edgesOf(modules, "src/index.ts")).toEqual([
      { from: "src/index.ts", to: "src/b.ts", kind: "runtime_import", confidence: "high" },
    ]);
  });

  it("keeps a best-effort target when the relative file is unknown", () => {
    const { modules } = analyzer.analyze([
      file("src/a.ts", "import './missing';"),
    ]);
    expect(edgesOf(modules, "src/a.ts")).toEqual([
      { from: "src/a.ts", to: "src/missing", kind: "runtime_import", confidence: "high" },
    ]);
  });
});

describe("TsJsImportAnalyzer — type-only imports", () => {
  it("classifies `import type` as type_only_import", () => {
    const { modules } = analyzer.analyze([
      file("src/a.ts", "import type { T } from './types';"),
      file("src/types.ts", ""),
    ]);
    expect(edgesOf(modules, "src/a.ts")).toEqual([
      { from: "src/a.ts", to: "src/types.ts", kind: "type_only_import", confidence: "high" },
    ]);
  });

  it("classifies `export type ... from` as type_only_import", () => {
    const { modules } = analyzer.analyze([
      file("src/a.ts", "export type { T } from './types';"),
      file("src/types.ts", ""),
    ]);
    expect(edgesOf(modules, "src/a.ts")[0]?.kind).toBe("type_only_import");
  });
});

describe("TsJsImportAnalyzer — aliased imports → medium (§7.5)", () => {
  it("marks alias specifiers as medium confidence", () => {
    const { modules } = analyzer.analyze([
      file("src/a.ts", "import { x } from '@/utils';"),
    ]);
    expect(edgesOf(modules, "src/a.ts")).toEqual([
      { from: "src/a.ts", to: "@/utils", kind: "runtime_import", confidence: "medium" },
    ]);
  });

  it("treats tilde-prefixed specifiers as aliases", () => {
    const { modules } = analyzer.analyze([
      file("src/a.ts", "import '~/shared/env';"),
    ]);
    expect(edgesOf(modules, "src/a.ts")[0]?.confidence).toBe("medium");
  });
});

describe("TsJsImportAnalyzer — dynamic imports → low|unknown (Req 19.6)", () => {
  it("marks a dynamic import with a static string as low confidence", () => {
    const { modules } = analyzer.analyze([
      file("src/a.ts", "const m = await import('./b');"),
      file("src/b.ts", ""),
    ]);
    expect(edgesOf(modules, "src/a.ts")).toEqual([
      { from: "src/a.ts", to: "src/b.ts", kind: "dynamic_unknown", confidence: "low" },
    ]);
  });

  it("marks a non-literal (reflection-based) dynamic import as unknown", () => {
    const { modules } = analyzer.analyze([
      file("src/a.ts", "const name = getName();\nconst m = await import(name);"),
    ]);
    expect(edgesOf(modules, "src/a.ts")).toEqual([
      { from: "src/a.ts", to: DYNAMIC_TARGET, kind: "dynamic_unknown", confidence: "unknown" },
    ]);
  });
});

describe("TsJsImportAnalyzer — require() and edge kinds", () => {
  it("records a relative require() as a high-confidence runtime edge", () => {
    const { modules } = analyzer.analyze([
      file("src/a.js", "const b = require('./b');"),
      file("src/b.js", ""),
    ]);
    expect(edgesOf(modules, "src/a.js")).toEqual([
      { from: "src/a.js", to: "src/b.js", kind: "runtime_import", confidence: "high" },
    ]);
  });

  it("classifies imports from a test file as test_dependency", () => {
    const { modules } = analyzer.analyze([
      file("src/a.test.ts", "import { subject } from './a';"),
      file("src/a.ts", ""),
    ]);
    expect(edgesOf(modules, "src/a.test.ts")).toEqual([
      { from: "src/a.test.ts", to: "src/a.ts", kind: "test_dependency", confidence: "high" },
    ]);
  });
});

describe("TsJsImportAnalyzer — bare package specifiers excluded (§7.6)", () => {
  it("does not emit module edges for bare npm packages", () => {
    const { modules } = analyzer.analyze([
      file("src/a.ts", "import React from 'react';\nimport { z } from '@scope/pkg';"),
    ]);
    expect(edgesOf(modules, "src/a.ts")).toEqual([]);
  });

  it("ignores non-source files entirely", () => {
    const { modules } = analyzer.analyze([
      file("README.md", "import { x } from './x';"),
    ]);
    expect(modules).toEqual([]);
  });
});

describe("TsJsImportAnalyzer — metadata-only guarantee (Req 19.2)", () => {
  it("ignores commented-out imports", () => {
    const { modules } = analyzer.analyze([
      file(
        "src/a.ts",
        "// import { secret } from './secret';\n/* import './blocked'; */\nimport { real } from './real';",
      ),
      file("src/real.ts", ""),
    ]);
    expect(edgesOf(modules, "src/a.ts")).toEqual([
      { from: "src/a.ts", to: "src/real.ts", kind: "runtime_import", confidence: "high" },
    ]);
  });

  it("emits only specifiers and never file body content", () => {
    const body =
      "const API_KEY = 'sk-super-secret-value';\nimport { b } from './b';\nconst data = 'sensitive payload';";
    const { modules } = analyzer.analyze([file("src/a.ts", body), file("src/b.ts", "")]);
    const serialized = JSON.stringify(modules);
    expect(serialized).not.toContain("sk-super-secret-value");
    expect(serialized).not.toContain("sensitive payload");
    expect(serialized).toContain("src/b.ts");
  });

  it("deduplicates identical edges within a file", () => {
    const { modules } = analyzer.analyze([
      file("src/a.ts", "import { x } from './b';\nimport { y } from './b';"),
      file("src/b.ts", ""),
    ]);
    expect(edgesOf(modules, "src/a.ts")).toHaveLength(1);
  });

  it("returns an empty contracts array (fingerprints land in task 5.2)", () => {
    const { contracts } = analyzer.analyze([file("src/a.ts", "import './b';")]);
    expect(contracts).toEqual([]);
  });
});
