/**
 * Tests for user-provided custom framework definitions.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCustomFrameworks } from "../../src/frameworks/custom.js";
import { getFramework } from "../../src/frameworks/registry.js";
import "../../src/frameworks/definitions.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "silo-custom-fw-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const VALID_YAML = `
id: my-agent
name: My Agent
description: An experimental autonomous agent
install:
  method: pip
  packages: ["my-agent-pkg"]
healthCheck: my-agent --version
tuiCommand: my-agent
envVars:
  OPENAI_API_BASE: "http://llm.gateway:8199/v1"
  OPENAI_API_KEY: "silo-proxy-injected"
`;

describe("loadCustomFrameworks", () => {
  it("returns empty result for a missing directory", () => {
    const result = loadCustomFrameworks(join(dir, "does-not-exist"));
    expect(result.loaded).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("registers a valid YAML definition with defaults applied", () => {
    writeFileSync(join(dir, "my-agent.yaml"), VALID_YAML);

    const result = loadCustomFrameworks(dir);
    expect(result.loaded).toEqual(["my-agent"]);
    expect(result.errors).toEqual([]);

    const fw = getFramework("my-agent")!;
    expect(fw.name).toBe("My Agent");
    expect(fw.install.method).toBe("pip");
    expect(fw.tuiCommand).toBe("my-agent");
    expect(fw.envVars?.["OPENAI_API_BASE"]).toBe("http://llm.gateway:8199/v1");
    // Schema defaults
    expect(fw.version).toBe("latest");
    expect(fw.entrypoint).toBeNull();
    expect(fw.tags).toContain("custom");
    expect(fw.icon).toBe("🤖");
  });

  it("registers a valid JSON definition", () => {
    writeFileSync(
      join(dir, "json-agent.json"),
      JSON.stringify({
        id: "json-agent",
        name: "JSON Agent",
        install: { method: "npm", packages: ["json-agent"] },
        healthCheck: "json-agent --version",
      }),
    );

    const result = loadCustomFrameworks(dir);
    expect(result.loaded).toEqual(["json-agent"]);
    expect(getFramework("json-agent")?.install.method).toBe("npm");
  });

  it("skips invalid definitions without throwing", () => {
    writeFileSync(join(dir, "broken.yaml"), "id: [not, a, string]\n");
    writeFileSync(join(dir, "incomplete.yaml"), "id: incomplete\nname: No Install\n");
    writeFileSync(join(dir, "valid.yaml"), VALID_YAML.replace("my-agent", "ok-agent"));

    const result = loadCustomFrameworks(dir);
    expect(result.loaded).toEqual(["ok-agent"]);
    expect(result.errors).toHaveLength(2);
    expect(getFramework("incomplete")).toBeUndefined();
  });

  it("rejects ids that would break image tags or CLI flags", () => {
    writeFileSync(
      join(dir, "bad-id.yaml"),
      VALID_YAML.replace("id: my-agent", "id: 'My Agent!!'"),
    );

    const result = loadCustomFrameworks(dir);
    expect(result.loaded).toEqual([]);
    expect(result.errors).toHaveLength(1);
  });

  it("allows overriding a built-in definition", () => {
    writeFileSync(
      join(dir, "override.yaml"),
      VALID_YAML.replace("id: my-agent", "id: aider").replace(
        "name: My Agent",
        "name: Aider (custom)",
      ),
    );

    const result = loadCustomFrameworks(dir);
    expect(result.loaded).toEqual(["aider"]);
    expect(getFramework("aider")?.name).toBe("Aider (custom)");
  });

  it("ignores non-definition files", () => {
    writeFileSync(join(dir, "README.md"), "# not a framework");
    writeFileSync(join(dir, "notes.txt"), "scratch");

    const result = loadCustomFrameworks(dir);
    expect(result.loaded).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});
