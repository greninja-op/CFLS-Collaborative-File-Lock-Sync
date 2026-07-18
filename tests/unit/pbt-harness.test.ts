import { describe, expect, it } from "vitest";

import {
  FEATURE_NAME,
  MIN_PBT_RUNS,
  assertProperty,
  fc,
  pbtParameters,
  propertyTag,
} from "@cfls/test-utils";

describe("PBT harness (@cfls/test-utils)", () => {
  it("builds the standard property tag string", () => {
    expect(propertyTag(1, "Event_Revision monotonicity and total order")).toBe(
      "Feature: collaborative-file-lock-sync, Property 1: Event_Revision monotonicity and total order",
    );
    expect(FEATURE_NAME).toBe("collaborative-file-lock-sync");
  });

  it("trims tag text and rejects invalid property numbers", () => {
    expect(propertyTag(2, "  padded  ")).toBe(
      "Feature: collaborative-file-lock-sync, Property 2: padded",
    );
    expect(() => propertyTag(0, "x")).toThrow(RangeError);
    expect(() => propertyTag(1, "   ")).toThrow(RangeError);
  });

  it("enforces the minimum run count and never lowers it", () => {
    expect(pbtParameters().numRuns).toBe(MIN_PBT_RUNS);
    expect(pbtParameters({ numRuns: 1 }).numRuns).toBe(MIN_PBT_RUNS);
    expect(pbtParameters({ numRuns: 500 }).numRuns).toBe(500);
  });

  it("runs a fast-check property through assertProperty", () => {
    // Sanity check that fast-check + the wrapper actually execute a property.
    assertProperty(
      fc.property(fc.integer(), fc.integer(), (a, b) => a + b === b + a),
    );
  });
});
