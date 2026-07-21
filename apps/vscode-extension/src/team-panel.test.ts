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
  ],
};

describe("buildTeamPanelHtml", () => {
  it("renders the team shell while escaping dynamic state for the script context", () => {
    const html = buildTeamPanelHtml(viewModel, "Team Demo");

    expect(html).toContain("CFLS Team Coordination");
    expect(html).toContain("Active team members");
    expect(html).toContain("Diff privacy");
    expect(html).toContain("\\u003cscript\\u003ealert(1)\\u003c/script\\u003e");
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});
