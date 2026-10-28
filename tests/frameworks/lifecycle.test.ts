import { describe, expect, it } from "vitest";
import { satisfiesVersionRequirement } from "../../src/frameworks/lifecycle.js";

describe("framework runtime version checks", () => {
  it("accepts versions that satisfy a minimum requirement", () => {
    expect(satisfiesVersionRequirement("v22.19.0", ">=22.19.0")).toBe(true);
    expect(satisfiesVersionRequirement("v22.20.1", ">=22.19.0")).toBe(true);
    expect(satisfiesVersionRequirement("v23.0.0", ">=22.19.0")).toBe(true);
  });

  it("rejects versions below the minimum requirement", () => {
    expect(satisfiesVersionRequirement("v20.19.2", ">=22.19.0")).toBe(false);
    expect(satisfiesVersionRequirement("v22.18.9", ">=22.19.0")).toBe(false);
    expect(satisfiesVersionRequirement("not installed", ">=22.19.0")).toBe(false);
  });
});
