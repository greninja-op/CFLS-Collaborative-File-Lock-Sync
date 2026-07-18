/**
 * Unit tests for public-contract fingerprint extraction (task 5.2; design
 * §7.1, §7.6, Req 19.2). Verifies the six contract kinds, the hashes-only
 * guarantee (no contract contents leak), exclusion, and stability.
 */

import { createHash } from "node:crypto";

import type { PublicContractFingerprint } from "@cfls/protocol";
import { describe, expect, it } from "vitest";

import {
  extractContractFingerprints,
  extractExportedNames,
  extractTsJsContracts,
} from "./contracts";
import type { RepoRelativeFile } from "./language-analyzer";

function file(path: string, content: string): RepoRelativeFile {
  return { path, content };
}

function byId(
  contracts: PublicContractFingerprint[],
  id: string,
): PublicContractFingerprint | undefined {
  return contracts.find((c) => c.id === id);
}

describe("extractExportedNames", () => {
  it("captures declaration, named, star, and default exports by name only", () => {
    const source = [
      "export function alpha() { return 'secret-body'; }",
      "export const beta = 42;",
      "export class Gamma {}",
      "export interface Delta { x: number }",
      "export type Epsilon = string;",
      "export enum Zeta { A, B }",
      "const eta = 1, theta = 2;",
      "export { eta, theta as thetaAlias };",
      "export * as ns from './other';",
      "export default function () {}",
    ].join("\n");

    expect(extractExportedNames(source)).toEqual([
      "Delta",
      "Epsilon",
      "Gamma",
      "Zeta",
      "alpha",
      "beta",
      "eta",
      "ns",
      "thetaAlias",
    ]);
  });

  it("ignores commented-out exports", () => {
    const source = "// export const hidden = 1;\nexport const shown = 2;";
    expect(extractExportedNames(source)).toEqual(["shown"]);
  });

  it("records a bare `export default <expr>` as `default`", () => {
    expect(extractExportedNames("const x = 1;\nexport default x;")).toEqual([
      "default",
    ]);
  });
});

describe("extractContractFingerprints — TS/JS surfaces", () => {
  it("classifies index/main entry files as public_api and others as exported_interface", () => {
    const contracts = extractContractFingerprints([
      file("src/index.ts", "export const a = 1;"),
      file("src/service.ts", "export function svc() {}"),
    ]);
    expect(byId(contracts, "src/index.ts")?.kind).toBe("public_api");
    expect(byId(contracts, "src/service.ts")?.kind).toBe("exported_interface");
  });

  it("emits no fingerprint for a module with no exports", () => {
    const contracts = extractContractFingerprints([
      file("src/a.ts", "import './b';\nconst local = 1;"),
    ]);
    expect(contracts).toEqual([]);
  });

  it("fingerprint changes when the exported surface changes", () => {
    const before = extractContractFingerprints([
      file("src/api.ts", "export const a = 1;"),
    ]);
    const after = extractContractFingerprints([
      file("src/api.ts", "export const a = 1;\nexport const b = 2;"),
    ]);
    expect(before[0]?.fingerprint).not.toBe(after[0]?.fingerprint);
  });

  it("fingerprint is stable when only bodies change (names identical)", () => {
    const v1 = extractContractFingerprints([
      file("src/api.ts", "export const a = 1;"),
    ]);
    const v2 = extractContractFingerprints([
      file("src/api.ts", "export const a = 99999;"),
    ]);
    expect(v1[0]?.fingerprint).toBe(v2[0]?.fingerprint);
  });
});

describe("extractContractFingerprints — non-source contracts", () => {
  it("classifies db, api, migration, and build-config files", () => {
    const contracts = extractContractFingerprints([
      file("prisma/schema.prisma", "model User {}"),
      file("db/init.sql", "CREATE TABLE t (id int);"),
      file("api/openapi.yaml", "openapi: 3.0.0"),
      file("src/schema.graphql", "type Query { me: String }"),
      file("migrations/0001_init.sql", "CREATE TABLE m (id int);"),
      file("tsconfig.json", "{}"),
      file(".github/workflows/ci.yml", "name: ci"),
    ]);
    const kinds = Object.fromEntries(contracts.map((c) => [c.id, c.kind]));
    expect(kinds["prisma/schema.prisma"]).toBe("db_schema");
    expect(kinds["db/init.sql"]).toBe("db_schema");
    expect(kinds["api/openapi.yaml"]).toBe("api_schema");
    expect(kinds["src/schema.graphql"]).toBe("api_schema");
    expect(kinds["migrations/0001_init.sql"]).toBe("migration");
    expect(kinds["tsconfig.json"]).toBe("build_config");
    expect(kinds[".github/workflows/ci.yml"]).toBe("build_config");
  });

  it("prioritizes migration over db_schema for SQL under a migrations folder", () => {
    const contracts = extractContractFingerprints([
      file("db/migrations/0002_add.sql", "ALTER TABLE t ADD c int;"),
    ]);
    expect(contracts[0]?.kind).toBe("migration");
  });

  it("hashes file content for non-source contracts", () => {
    const content = "model User { id Int @id }";
    const expected = createHash("sha256").update(content).digest("hex");
    const contracts = extractContractFingerprints([
      file("prisma/schema.prisma", content),
    ]);
    expect(contracts[0]?.fingerprint).toBe(expected);
  });
});

describe("extractContractFingerprints — hashes-only guarantee (Req 19.2)", () => {
  it("never includes exported initializer values or bodies", () => {
    const serialized = JSON.stringify(
      extractContractFingerprints([
        file("src/index.ts", "export const KEY = 'sk-super-secret';"),
      ]),
    );
    expect(serialized).not.toContain("sk-super-secret");
  });

  it("applies the exclusion list before fingerprinting", () => {
    const contracts = extractContractFingerprints([
      file("node_modules/pkg/index.js", "export const x = 1;"),
      file(".env", "SECRET=1"),
      file("dist/bundle.js", "export const y = 2;"),
    ]);
    expect(contracts).toEqual([]);
  });

  it("returns a deterministic order sorted by (kind, id)", () => {
    const contracts = extractContractFingerprints([
      file("src/z.ts", "export const z = 1;"),
      file("src/a.ts", "export const a = 1;"),
      file("tsconfig.json", "{}"),
    ]);
    expect(contracts.map((c) => `${c.kind}:${c.id}`)).toEqual([
      "build_config:tsconfig.json",
      "exported_interface:src/a.ts",
      "exported_interface:src/z.ts",
    ]);
  });
});

describe("extractTsJsContracts", () => {
  it("returns only public_api / exported_interface fingerprints", () => {
    const contracts = extractTsJsContracts([
      file("src/index.ts", "export const a = 1;"),
      file("prisma/schema.prisma", "model X {}"),
      file("tsconfig.json", "{}"),
    ]);
    expect(contracts).toHaveLength(1);
    expect(contracts[0]?.kind).toBe("public_api");
  });
});
