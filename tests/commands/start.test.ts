import { describe, expect, it } from "vitest";
import {
  ensureBrowserMemoryLimit,
  parseMemoryToMiB,
} from "../../src/commands/start.js";

describe("browser memory limits", () => {
  it("parses Docker-style memory values into MiB", () => {
    expect(parseMemoryToMiB("512m")).toBe(512);
    expect(parseMemoryToMiB("2g")).toBe(2048);
    expect(parseMemoryToMiB("1.5gb")).toBe(1536);
    expect(parseMemoryToMiB("1048576")).toBe(1);
    expect(parseMemoryToMiB("bad-value")).toBeNull();
  });

  it("raises browser runs to at least 2g without lowering larger limits", () => {
    expect(ensureBrowserMemoryLimit("512m")).toEqual({
      memoryLimit: "2g",
      bumped: true,
    });
    expect(ensureBrowserMemoryLimit("2g")).toEqual({
      memoryLimit: "2g",
      bumped: false,
    });
    expect(ensureBrowserMemoryLimit("3g")).toEqual({
      memoryLimit: "3g",
      bumped: false,
    });
  });
});
