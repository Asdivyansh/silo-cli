import { describe, it, expect } from "vitest";

// Import definitions first to populate the registry
import "../../src/frameworks/definitions.js";
import {
  getFramework,
  listFrameworks,
  listFrameworkIds,
  isValidFramework,
  frameworkImageTag,
} from "../../src/frameworks/registry.js";

// ---------------------------------------------------------------------------
// Registry population
// ---------------------------------------------------------------------------

describe("framework registry", () => {
  it("has all 5 frameworks registered", () => {
    const frameworks = listFrameworks();
    expect(frameworks.length).toBe(5);
  });

  it("all expected framework IDs exist", () => {
    const ids = listFrameworkIds();
    expect(ids).toContain("crewai");
    expect(ids).toContain("langgraph");
    expect(ids).toContain("openclaw");
    expect(ids).toContain("aider");
    expect(ids).toContain("swe-agent");
  });
});

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

describe("getFramework", () => {
  it("returns framework definition by ID", () => {
    const crewai = getFramework("crewai");
    expect(crewai).toBeDefined();
    expect(crewai!.name).toBe("CrewAI");
    expect(crewai!.install.method).toBe("pip");
    expect(crewai!.install.packages).toContain("crewai");
  });

  it("is case-insensitive", () => {
    const fw1 = getFramework("CrewAI");
    const fw2 = getFramework("CREWAI");
    const fw3 = getFramework("crewai");

    expect(fw1?.id).toBe("crewai");
    expect(fw2?.id).toBe("crewai");
    expect(fw3?.id).toBe("crewai");
  });

  it("returns undefined for unknown framework", () => {
    expect(getFramework("nonexistent")).toBeUndefined();
    expect(getFramework("")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("isValidFramework", () => {
  it("returns true for registered frameworks", () => {
    expect(isValidFramework("crewai")).toBe(true);
    expect(isValidFramework("langgraph")).toBe(true);
    expect(isValidFramework("aider")).toBe(true);
  });

  it("returns false for unknown frameworks", () => {
    expect(isValidFramework("unknown")).toBe(false);
    expect(isValidFramework("")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isValidFramework("CrewAI")).toBe(true);
    expect(isValidFramework("LANGGRAPH")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Image tags
// ---------------------------------------------------------------------------

describe("frameworkImageTag", () => {
  it("generates correct Docker image tag", () => {
    expect(frameworkImageTag("crewai")).toBe("silo-sandbox-crewai:latest");
    expect(frameworkImageTag("langgraph")).toBe("silo-sandbox-langgraph:latest");
  });

  it("lowercases framework ID", () => {
    expect(frameworkImageTag("CrewAI")).toBe("silo-sandbox-crewai:latest");
  });

  it("generates browser-capable variant tags", () => {
    expect(frameworkImageTag("openclaw", { browser: true })).toBe(
      "silo-sandbox-openclaw-browser:latest",
    );
  });

  it("generates browser-capable variant tags for every framework", () => {
    for (const framework of listFrameworks()) {
      expect(frameworkImageTag(framework.id, { browser: true })).toBe(
        `silo-sandbox-${framework.id}-browser:latest`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Framework definition structure
// ---------------------------------------------------------------------------

describe("framework definition integrity", () => {
  it("every framework has required fields", () => {
    const frameworks = listFrameworks();
    for (const fw of frameworks) {
      expect(fw.id).toBeTruthy();
      expect(fw.name).toBeTruthy();
      expect(fw.description).toBeTruthy();
      expect(fw.version).toBeTruthy();
      expect(fw.install).toBeDefined();
      expect(fw.install.method).toMatch(/^(pip|npm|custom)$/);
      expect(fw.healthCheck).toBeTruthy();
      expect(fw.tags).toBeDefined();
      expect(fw.tags.length).toBeGreaterThan(0);
      expect(fw.docsUrl).toMatch(/^https?:\/\//);
      expect(fw.icon).toBeTruthy();
    }
  });

  it("pip frameworks have packages listed", () => {
    const frameworks = listFrameworks().filter((f) => f.install.method === "pip");
    for (const fw of frameworks) {
      expect(fw.install.packages.length).toBeGreaterThan(0);
    }
  });

  it("custom frameworks have dockerSnippet", () => {
    const frameworks = listFrameworks().filter((f) => f.install.method === "custom");
    for (const fw of frameworks) {
      expect(fw.install.dockerSnippet).toBeTruthy();
    }
  });

  it("all frameworks have unique IDs", () => {
    const ids = listFrameworkIds();
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it("all frameworks have unique names", () => {
    const names = listFrameworks().map((f) => f.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });

  it("keeps OpenClaw gateway launch durable and idempotent", () => {
    const openclaw = getFramework("openclaw")!;

    expect(openclaw.prelaunchCommand).toContain("openclaw health");
    expect(openclaw.prelaunchCommand).toContain("exec openclaw gateway run");
    expect(openclaw.prelaunchCommand).toContain("gateway.log");
    expect(openclaw.prelaunchCommand).not.toMatch(/gateway run\s*&/);
  });

  it("gives OpenClaw enough writable home tmpfs for sessions and logs", () => {
    const openclaw = getFramework("openclaw")!;

    expect(openclaw.tmpfsMounts).toContain("/home/agent");
    expect(openclaw.tmpfsMountSizes?.["/home/agent"]).toBe("256m");
  });
});
