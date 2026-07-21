import type { SessionId } from "@cfls/protocol";
import { describe, expect, it } from "vitest";

import { AgentView } from "./view";

const session: SessionId = {
  repoId: "github.com/example/cfls",
  teamId: "demo-team",
  branch: "main",
  baseRevision: null,
};

describe("AgentView.teamActivity", () => {
  it("retains declared task descriptions alongside a member's live files", () => {
    const view = new AgentView();
    const member = { memberId: "alice", deviceId: "alice-laptop" };
    view.applyUpdates(session, [
      {
        entryType: "presence",
        op: "added",
        path: "src/api.ts",
        member,
        eventRevision: 1,
      },
      {
        entryType: "intent",
        op: "added",
        path: "src/api.ts",
        member,
        eventRevision: 2,
        intent: {
          intentId: "intent-api",
          description: "Refine API response handling",
        },
      },
      {
        entryType: "planned_file_creation",
        op: "added",
        path: "src/api.test.ts",
        member,
        eventRevision: 3,
        intent: {
          intentId: "intent-api",
          description: "Refine API response handling",
        },
      },
    ]);

    expect(view.teamActivity(session)).toEqual([
      {
        memberId: "alice",
        deviceIds: ["alice-laptop"],
        files: [
          { path: "src/api.test.ts", roles: ["planned-create"] },
          { path: "src/api.ts", roles: ["editing", "intent"] },
        ],
        tasks: [
          {
            intentId: "intent-api",
            description: "Refine API response handling",
            modifyPaths: ["src/api.ts"],
            createPaths: ["src/api.test.ts"],
          },
        ],
        lastEventRevision: 3,
      },
    ]);
  });
});
