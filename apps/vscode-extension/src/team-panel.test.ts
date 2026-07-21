import { describe, expect, it } from "vitest";

import { buildTeamPanelHtml } from "./team-panel";
import type { CoordinationViewModel } from "./view-model";

const viewModel: CoordinationViewModel = {
  paths: [],
  plannedFileCreations: [],
  offline: false,
  stale: false,
  secondsSinceSync: 0,
  statusText: "Online",
  teamId: "team-demo",
  members: [
    {
      memberId: "<script>alert(1)</script>",
      connectionState: "connected",
      activityKnown: true,
      deviceIds: ["device-1"],
      files: [{ path: "src/demo.ts", roles: ["editing"] }],
      tasks: [
        {
          intentId: "intent-1",
          description: "</script><img src=x>",
          modifyPaths: ["src/demo.ts"],
          createPaths: [],
        },
      ],
      lastEventRevision: 4,
    },
    {
      memberId: "idle-offline-member",
      connectionState: "offline",
      activityKnown: false,
      deviceIds: [],
      files: [],
      tasks: [],
      lastEventRevision: null,
    },
  ],
};

describe("buildTeamPanelHtml", () => {
  it("renders the team shell while escaping dynamic state for the script context", () => {
    const html = buildTeamPanelHtml(viewModel, "Team Demo", {
      selfMemberId: "alice",
      localDiffPreview: {
        path: "src/demo.ts",
        changedLines: 1,
        truncated: false,
        lines: [{ kind: "added", text: "const demo = true;" }],
      },
    });

    expect(html).toContain("CFLS Team Coordination");
    expect(html).toContain("Team members");
    expect(html).toContain("connectionLabel");
    expect(html).toContain('"connectionState":"offline"');
    expect(html).toContain('"activityKnown":false');
    expect(html).toContain("Your local diff preview");
    expect(html).toContain("Teammate diff preview");
    expect(html).toContain("source stays local");
    expect(html).toContain('"selfMemberId":"alice"');
    expect(html).toContain("\\u003cscript\\u003ealert(1)\\u003c/script\\u003e");
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});
