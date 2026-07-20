/**
 * Unit tests for snapshot-vs-delta decision and Change_Delta_Metadata
 * computation (task 5.3; design §7.3, §7.4; Req 19.3, 19.4, 19.5, 20.1).
 */

import { describe, expect, it } from "vitest";

import type { DependencyGraph, SessionId } from "@cfls/protocol";

import {
  computeDelta,
  decideUpload,
  isEmptyDelta,
  sameSnapshotIdentity,
  snapshotIdentityKey,
} from "./delta";
import { buildDependencyGraph } from "./graph";
import type { RepoRelativeFile } from "./language-analyzer";

function file(path: string, content: string): RepoRelativeFile {
  return { path, content };
}

const SESSION: SessionId = {
  repoId: "git@github.com:acme/app.git",
  teamId: "team-1",
  branch: "main",
  baseRevision: "abc123",
};

function graphFrom(
  files: RepoRelativeFile[],
  graphVersion: number,
  session: SessionId = SESSION,
): DependencyGraph {
  return buildDependencyGraph(session, files, { graphVersion });
}

describe("snapshot identity", () => {
  it("keys on repoId, teamId, branch, and baseRevision", () => {
    const other: SessionId = { ...SESSION, branch: "feature" };
    expect(sameSnapshotIdentity(SESSION, { ...SESSION })).toBe(true);
    expect(sameSnapshotIdentity(SESSION, other)).toBe(false);
    expect(snapshotIdentityKey(SESSION)).not.toBe(snapshotIdentityKey(other));
  });

  it("treats a null baseRevision distinctly and stably", () => {
    const noBase: SessionId = { ...SESSION, baseRevision: null };
    expect(snapshotIdentityKey(noBase)).toBe(
      snapshotIdentityKey({ ...noBase }),
    );
    expect(sameSnapshotIdentity(noBase, SESSION)).toBe(false);
  });
});

describe("computeDelta", () => {
  it("reports added and removed edges", () => {
    const before = graphFrom(
      [
        file("src/a.ts", "export const a = 1;"),
        file("src/b.ts", "export const b = 2;"),
      ],
      1,
    );
    const after = graphFrom(
      [
        file("src/a.ts", "import './b';\nexport const a = 1;"),
        file("src/b.ts", "export const b = 2;"),
      ],
      2,
    );

    const delta = computeDelta(before, after);
    expect(delta.changedEdges).toEqual([
      {
        from: "src/a.ts",
        to: "src/b.ts",
        kind: "runtime_import",
        confidence: "high",
        op: "add",
      },
    ]);

    // The reverse direction reports the same edge as a removal.
    const reverse = computeDelta(after, before);
    expect(reverse.changedEdges).toEqual([
      {
        from: "src/a.ts",
        to: "src/b.ts",
        kind: "runtime_import",
        confidence: "high",
        op: "remove",
      },
    ]);
  });

  it("reports changed manifests and lockfile hash", () => {
    const before = graphFrom(
      [
        file(
          "package.json",
          JSON.stringify({ dependencies: { react: "^18" } }),
        ),
        file("package-lock.json", "{}"),
      ],
      1,
    );
    const after = graphFrom(
      [
        file(
          "package.json",
          JSON.stringify({ dependencies: { react: "^19" } }),
        ),
        file("package-lock.json", '{"changed":true}'),
      ],
      2,
    );

    const delta = computeDelta(before, after);
    expect(delta.changedManifests).toEqual(["package.json"]);
    expect(delta.changedLockfileHash).toBeDefined();
    expect(delta.changedLockfileHash).not.toBe("");
  });

  it("reports added, changed, and removed contracts", () => {
    const before = graphFrom(
      [
        file("src/a.ts", "export const a = 1;"),
        file("src/b.ts", "export const b = 2;"),
      ],
      1,
    );
    const after = graphFrom(
      [
        file("src/a.ts", "export const a = 1;\nexport const a2 = 3;"), // changed surface
        file("src/c.ts", "export const c = 4;"), // added
      ],
      2,
    );

    const delta = computeDelta(before, after);
    const byId = Object.fromEntries(
      delta.changedContracts.map((c) => [c.id, c]),
    );

    expect(byId["src/c.ts"]?.fingerprint).not.toBe(""); // added
    expect(byId["src/a.ts"]?.fingerprint).not.toBe(""); // changed
    expect(byId["src/b.ts"]?.fingerprint).toBe(""); // removed → empty fingerprint
  });

  it("yields an empty delta for identical graphs", () => {
    const files = [
      file("src/a.ts", "import './b';"),
      file("src/b.ts", "export const b = 1;"),
    ];
    const g1 = graphFrom(files, 1);
    const g2 = graphFrom(files, 2);
    expect(isEmptyDelta(computeDelta(g1, g2))).toBe(true);
  });
});

describe("decideUpload", () => {
  const local = graphFrom([file("src/a.ts", "export const a = 1;")], 1);

  it("sends a snapshot when the host holds nothing for the identity", () => {
    expect(decideUpload({ localGraph: local, hostGraph: null })).toEqual({
      kind: "snapshot",
      graph: local,
    });
  });

  it("sends a snapshot when the host holds a different identity", () => {
    const decision = decideUpload({
      localGraph: local,
      hostGraph: {
        sessionId: { ...SESSION, branch: "other" },
        graphVersion: 1,
      },
    });
    expect(decision.kind).toBe("snapshot");
  });

  it("uploads nothing when the host already holds this graph version (Req 19.5)", () => {
    expect(
      decideUpload({
        localGraph: local,
        hostGraph: { sessionId: SESSION, graphVersion: 1 },
      }),
    ).toEqual({ kind: "none" });
  });

  it("uploads nothing when the host holds a newer version", () => {
    expect(
      decideUpload({
        localGraph: local,
        hostGraph: { sessionId: SESSION, graphVersion: 5 },
      }),
    ).toEqual({ kind: "none" });
  });

  it("sends a delta when the host is behind and a previous graph exists", () => {
    const previous = graphFrom([file("src/a.ts", "export const a = 1;")], 1);
    const next = graphFrom(
      [
        file("src/a.ts", "import './b';\nexport const a = 1;"),
        file("src/b.ts", "export const b = 2;"),
      ],
      2,
    );
    const decision = decideUpload({
      localGraph: next,
      hostGraph: { sessionId: SESSION, graphVersion: 1 },
      previousLocalGraph: previous,
    });
    expect(decision.kind).toBe("delta");
    if (decision.kind === "delta") {
      expect(decision.delta.changedEdges.length).toBeGreaterThan(0);
    }
  });

  it("collapses to none when the host is behind but nothing actually changed", () => {
    const files = [file("src/a.ts", "export const a = 1;")];
    const previous = graphFrom(files, 1);
    const next = graphFrom(files, 2);
    expect(
      decideUpload({
        localGraph: next,
        hostGraph: { sessionId: SESSION, graphVersion: 1 },
        previousLocalGraph: previous,
      }),
    ).toEqual({ kind: "none" });
  });

  it("falls back to a snapshot when behind with no previous graph", () => {
    const next = graphFrom([file("src/a.ts", "export const a = 1;")], 3);
    const decision = decideUpload({
      localGraph: next,
      hostGraph: { sessionId: SESSION, graphVersion: 1 },
    });
    expect(decision.kind).toBe("snapshot");
  });
});
