/** Unit tests for the pure in-editor coordination presentation helpers. */

import { describe, expect, it } from "vitest";

import {
  buildCoordinationStatusDetail,
  buildHoverMarkdown,
  buildStatusTooltip,
  decorateForPath,
  fileBadgeForPath,
} from "./presence-ui";
import type { CoordinationViewModel } from "./view-model";

function viewModel(
  overrides: Partial<CoordinationViewModel> = {},
): CoordinationViewModel {
  return {
    paths: [
      {
        path: "src/shared.ts",
        riskLevel: "coordination-required",
        presenceMembers: ["alice", "self"],
        softLockMembers: [],
        coordinationRequiredMembers: [],
        hardLockMembers: [],
        intentMembers: ["bob"],
        dependencyRiskMembers: [],
        indirectRisk: null,
        acknowledgementRequired: true,
      },
      {
        path: "src/critical.ts",
        riskLevel: "hard",
        presenceMembers: [],
        softLockMembers: [],
        coordinationRequiredMembers: [],
        hardLockMembers: ["carol"],
        intentMembers: [],
        dependencyRiskMembers: [],
        indirectRisk: null,
        acknowledgementRequired: false,
      },
    ],
    plannedFileCreations: [{ path: "src/new-file.ts", memberId: "dave" }],
    offline: false,
    stale: false,
    secondsSinceSync: 1,
    statusText: "Online",
    ...overrides,
  };
}

describe("buildHoverMarkdown", () => {
  it("returns null when a path has no coordination signal from another member", () => {
    const vm = viewModel({
      paths: [
        {
          ...viewModel().paths[0]!,
          presenceMembers: ["self"],
          intentMembers: [],
        },
      ],
    });

    expect(buildHoverMarkdown(vm, "src/shared.ts", "self")).toBeNull();
    expect(buildHoverMarkdown(vm, "src/missing.ts", "self")).toBeNull();
  });

  it("renders other members and risk while escaping markdown names", () => {
    const vm = viewModel({
      paths: [
        {
          ...viewModel().paths[0]!,
          presenceMembers: ["Alice *admin*"],
          intentMembers: ["Bob"],
        },
      ],
    });

    const hover = buildHoverMarkdown(vm, "./src/shared.ts", "self");
    expect(hover).toContain("CFLS — coordination");
    expect(hover).toContain("Alice \\*admin\\* is editing this file");
    expect(hover).toContain("Bob plans to change it");
    expect(hover).toContain("coordination-required");
  });
});

describe("decorateForPath", () => {
  it("maps the authoritative path risk and excludes the local member", () => {
    const vm = viewModel({
      paths: [
        {
          ...viewModel().paths[1]!,
          hardLockMembers: ["self", "carol"],
        },
      ],
    });

    expect(decorateForPath(vm, "src/critical.ts", "self")).toEqual({
      message: "🔒 carol hard lock",
      riskLevel: "hard",
    });
  });

  it("returns null when a path is only coordinated by self", () => {
    const vm = viewModel({
      paths: [
        {
          ...viewModel().paths[0]!,
          presenceMembers: ["self"],
          intentMembers: ["self"],
        },
      ],
    });

    expect(decorateForPath(vm, "src/shared.ts", "self")).toBeNull();
  });

  it("preserves each risk level for the adapter's colour mapping", () => {
    for (const riskLevel of [
      "soft",
      "coordination-required",
      "hard",
    ] as const) {
      const vm = viewModel({
        paths: [
          {
            ...viewModel().paths[0]!,
            riskLevel,
            presenceMembers: ["alice"],
            intentMembers: [],
          },
        ],
      });

      expect(decorateForPath(vm, "src/shared.ts", "self")?.riskLevel).toBe(
        riskLevel,
      );
    }
  });
});

describe("buildStatusTooltip", () => {
  it("lists other members and paths while excluding self and unknown secret-like fields", () => {
    const vm = viewModel() as CoordinationViewModel & { localApiToken: string };
    vm.localApiToken = "super-secret-token-value";

    const tooltip = buildStatusTooltip(vm, "self");
    expect(tooltip).toContain("src/shared.ts");
    expect(tooltip).toContain("alice is editing this file");
    expect(tooltip).toContain("bob plans to change it");
    expect(tooltip).toContain("src/new-file.ts");
    expect(tooltip).not.toContain("self is editing");
    expect(tooltip).not.toContain("super-secret-token-value");
  });

  it("does not expose a credential-shaped member id", () => {
    const vm = viewModel({
      paths: [
        {
          ...viewModel().paths[0]!,
          presenceMembers: ["sk_abcdefghijklmnopqrstuvwxyz"],
          intentMembers: [],
        },
      ],
    });

    const tooltip = buildStatusTooltip(vm, "self");
    expect(tooltip).toContain("a teammate is editing this file");
    expect(tooltip).not.toContain("sk_abcdefghijklmnopqrstuvwxyz");
  });
});

describe("buildCoordinationStatusDetail", () => {
  it("keeps the explicit command detail plain, self-filtered, and metadata-only", () => {
    const vm = viewModel() as CoordinationViewModel & { apiKey: string };
    vm.apiKey = "not-for-display";

    const detail = buildCoordinationStatusDetail(vm, "self");
    expect(detail).toContain("src/shared.ts");
    expect(detail).toContain("alice is editing this file");
    expect(detail).toContain("src/new-file.ts");
    expect(detail).not.toContain("self is editing");
    expect(detail).not.toContain("not-for-display");
    expect(detail).not.toContain("**");
  });
});

describe("fileBadgeForPath", () => {
  it("returns a lock badge and risk for a lock held by another member", () => {
    const badge = fileBadgeForPath(viewModel(), "src/critical.ts", "self");

    expect(badge).toEqual({
      badge: "🔒",
      tooltip: "carol holds a hard lock",
      riskLevel: "hard",
    });
  });

  it("uses the member initial for editing presence and ignores self-only paths", () => {
    const vm = viewModel();
    expect(fileBadgeForPath(vm, "src/shared.ts", "self")).toMatchObject({
      badge: "A",
      tooltip: "alice is editing this file",
      riskLevel: "coordination-required",
    });

    const selfOnly = viewModel({
      paths: [
        {
          ...viewModel().paths[0]!,
          presenceMembers: ["self"],
          intentMembers: [],
        },
      ],
    });
    expect(fileBadgeForPath(selfOnly, "src/shared.ts", "self")).toBeNull();
  });

  it("does not badge a path with only a teammate intent", () => {
    const intentOnly = viewModel({
      paths: [
        {
          ...viewModel().paths[0]!,
          presenceMembers: [],
          intentMembers: ["bob"],
        },
      ],
    });

    expect(fileBadgeForPath(intentOnly, "src/shared.ts", "self")).toBeNull();
  });
});
