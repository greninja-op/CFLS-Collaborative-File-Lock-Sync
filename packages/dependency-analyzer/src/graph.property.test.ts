/**
 * Property test (task 5.4) — Property 6: Dependency_Graph serialization
 * round-trip (design "Correctness Properties" §Property 6; Req 20.4).
 *
 * For any valid Dependency_Graph, `deserializeGraph(serializeGraph(graph))`
 * yields an equivalent graph preserving all five metadata categories:
 *   1. Repository_Snapshot_Metadata
 *   2. Package_Dependency_Metadata
 *   3. Module_Dependency_Metadata
 *   4. Public_Contract_Fingerprints
 *   5. Change_Delta_Metadata — round-tripped via serializeDelta/deserializeDelta.
 *
 * Because serialization is canonical, the recovered graph equals
 * `normalizeGraph(graph)` (the canonical form). We build a fast-check arbitrary
 * for {@link DependencyGraph} (and {@link ChangeDeltaMetadata}) and assert the
 * round-trip over ≥100 iterations.
 *
 * **Validates: Requirements 20.4**
 */

import { assertProperty, fc, propertyTag } from "@cfls/test-utils";
import { describe, expect, it } from "vitest";

import type {
  ChangeDeltaMetadata,
  Confidence,
  DependencyEdge,
  DependencyGraph,
  EdgeKind,
  ModuleDependencyMetadata,
  PackageDependencyMetadata,
  PublicContractFingerprint,
  SessionId,
} from "@cfls/protocol";

import {
  deserializeDelta,
  deserializeGraph,
  normalizeGraph,
  serializeDelta,
  serializeGraph,
} from "./graph";

// ---------------------------------------------------------------------------
// Arbitraries — build a valid DependencyGraph (and ChangeDeltaMetadata) that
// exercises every one of the five metadata categories.
// ---------------------------------------------------------------------------

const EDGE_KINDS: readonly EdgeKind[] = [
  "runtime_import",
  "type_only_import",
  "test_dependency",
  "build_dependency",
  "generated_dependency",
  "dynamic_unknown",
];

const CONFIDENCES: readonly Confidence[] = ["high", "medium", "low", "unknown"];

const PACKAGE_SCOPES = ["prod", "dev", "peer", "optional"] as const;

const CONTRACT_KINDS: readonly PublicContractFingerprint["kind"][] = [
  "public_api",
  "exported_interface",
  "db_schema",
  "api_schema",
  "migration",
  "build_config",
];

/** A short, non-empty token — stands in for a path / name / id. */
const token = fc.string({ minLength: 1, maxLength: 16 });

const sessionIdArb: fc.Arbitrary<SessionId> = fc.record({
  repoId: token,
  teamId: token,
  branch: token,
  baseRevision: fc.option(token, { nil: null }),
});

const edgeArb: fc.Arbitrary<DependencyEdge> = fc.record({
  from: token,
  to: token,
  kind: fc.constantFrom(...EDGE_KINDS),
  confidence: fc.constantFrom(...CONFIDENCES),
});

const packageArb: fc.Arbitrary<PackageDependencyMetadata> = fc.record({
  manifestPath: token,
  packageManager: token,
  directDependencyNames: fc.array(token, { maxLength: 6 }),
  declaredVersionRanges: fc.dictionary(token, token, { maxKeys: 6 }),
  scope: fc.constantFrom(...PACKAGE_SCOPES),
  lockfileHash: token,
});

const moduleArb: fc.Arbitrary<ModuleDependencyMetadata> = fc.record({
  sourceFile: token,
  edges: fc.array(edgeArb, { maxLength: 6 }),
});

const contractArb: fc.Arbitrary<PublicContractFingerprint> = fc.record({
  id: token,
  kind: fc.constantFrom(...CONTRACT_KINDS),
  fingerprint: token,
});

const graphArb: fc.Arbitrary<DependencyGraph> = fc.record({
  snapshot: fc.record({
    sessionId: sessionIdArb,
    graphVersion: fc.integer({ min: 0, max: 1000 }),
    analyzerVersion: token,
  }),
  packages: fc.array(packageArb, { maxLength: 5 }),
  modules: fc.array(moduleArb, { maxLength: 5 }),
  contracts: fc.array(contractArb, { maxLength: 5 }),
});

const changedEdgeArb: fc.Arbitrary<DependencyEdge & { op: "add" | "remove" }> =
  fc.record({
    from: token,
    to: token,
    kind: fc.constantFrom(...EDGE_KINDS),
    confidence: fc.constantFrom(...CONFIDENCES),
    op: fc.constantFrom<"add" | "remove">("add", "remove"),
  });

const deltaArb: fc.Arbitrary<ChangeDeltaMetadata> = fc.record(
  {
    changedEdges: fc.array(changedEdgeArb, { maxLength: 6 }),
    changedManifests: fc.array(token, { maxLength: 6 }),
    // Present-or-absent (exactOptionalPropertyTypes): the `requiredKeys` below
    // omit this field, so fast-check drops the key entirely instead of ever
    // producing an explicit `undefined` value.
    changedLockfileHash: token,
    changedContracts: fc.array(contractArb, { maxLength: 6 }),
  },
  { requiredKeys: ["changedEdges", "changedManifests", "changedContracts"] },
);

// ---------------------------------------------------------------------------

describe(propertyTag(6, "Dependency_Graph serialization round-trip"), () => {
  it("round-trips any valid graph (all five metadata categories) via canonical serialization", () => {
    assertProperty(
      fc.property(graphArb, deltaArb, (graph, delta) => {
        const canonical = normalizeGraph(graph);
        const round = deserializeGraph(serializeGraph(graph));

        // The whole graph recovers to its canonical, equivalent form.
        expect(round).toEqual(canonical);

        // Each of the four *stored* metadata categories is preserved.
        // 1. Repository_Snapshot_Metadata
        expect(round.snapshot).toEqual(canonical.snapshot);
        // 2. Package_Dependency_Metadata
        expect(round.packages).toEqual(canonical.packages);
        // 3. Module_Dependency_Metadata
        expect(round.modules).toEqual(canonical.modules);
        // 4. Public_Contract_Fingerprints
        expect(round.contracts).toEqual(canonical.contracts);

        // Serialization is deterministic: re-serializing the recovered graph
        // yields a byte-identical string.
        expect(serializeGraph(round)).toBe(serializeGraph(graph));

        // 5. Change_Delta_Metadata round-trips via serializeDelta/deserializeDelta.
        expect(deserializeDelta(serializeDelta(delta))).toEqual(delta);
      }),
    );
  });
});
