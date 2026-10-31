import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BUILTIN_PRESETS,
  getPreset,
  listPresets,
  applyPreset,
  removePreset,
} from "../../src/policy/presets.js";
import { parsePolicyFile } from "../../src/policy/engine.js";
import type { SiloConfig } from "../../src/config/schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(policyFile?: string): SiloConfig {
  return {
    version: "1",
    llm: { provider: "openai", apiKey: "sk-test", model: "gpt-4o" },
    sandbox: {
      image: "silo-sandbox:latest",
      containerName: "silo-agent",
      workspacePath: "/tmp/workspace",
      cpuLimit: "1.0",
      memoryLimit: "512m",
      policyFile,
    },
    proxy: { port: 8199, running: false, autoOpenLogs: true },
    integrations: [],
    onboardedAt: new Date().toISOString(),
  };
}

let tmpFile: string;

beforeEach(() => {
  tmpFile = join(tmpdir(), `silo-presets-test-${Date.now()}.yaml`);
});

afterEach(() => {
  try { unlinkSync(tmpFile); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe("BUILTIN_PRESETS", () => {
  it("contains pypi, npm, github, and huggingface presets", () => {
    expect(BUILTIN_PRESETS).toHaveProperty("pypi");
    expect(BUILTIN_PRESETS).toHaveProperty("npm");
    expect(BUILTIN_PRESETS).toHaveProperty("github");
    expect(BUILTIN_PRESETS).toHaveProperty("huggingface");
  });

  it("every preset has at least one rule", () => {
    for (const preset of Object.values(BUILTIN_PRESETS)) {
      expect(preset.rules.length).toBeGreaterThan(0);
    }
  });

  it("every rule has action='allow'", () => {
    for (const preset of Object.values(BUILTIN_PRESETS)) {
      for (const rule of preset.rules) {
        expect(rule.action).toBe("allow");
      }
    }
  });
});

describe("getPreset", () => {
  it("returns the preset for a known name", () => {
    expect(getPreset("pypi")).toBeDefined();
    expect(getPreset("pypi")?.name).toBe("pypi");
  });

  it("is case-insensitive", () => {
    expect(getPreset("PyPI")).toBeDefined();
    expect(getPreset("NPM")).toBeDefined();
  });

  it("returns undefined for an unknown preset", () => {
    expect(getPreset("unknown-preset")).toBeUndefined();
  });
});

describe("listPresets", () => {
  it("returns all registered presets", () => {
    expect(listPresets().length).toBe(Object.keys(BUILTIN_PRESETS).length);
  });
});

// ---------------------------------------------------------------------------
// applyPreset
// ---------------------------------------------------------------------------

describe("applyPreset", () => {
  it("creates a new policy file when none exists", () => {
    const config = makeConfig(tmpFile);
    const path = applyPreset(BUILTIN_PRESETS["pypi"]!, config);

    expect(existsSync(path)).toBe(true);
    const policy = parsePolicyFile(path);
    const hosts = policy.rules.map((r) => r.host);
    expect(hosts).toContain("pypi.org");
    expect(hosts).toContain("files.pythonhosted.org");
  });

  it("merges rules into an existing policy without duplicates", () => {
    // Write a base policy
    writeFileSync(
      tmpFile,
      `version: "1"\nname: base\ndefault: deny\nrules:\n  - host: llm.gateway\n    action: allow\n`,
      "utf8",
    );

    const config = makeConfig(tmpFile);
    applyPreset(BUILTIN_PRESETS["npm"]!, config);

    const policy = parsePolicyFile(tmpFile);
    const hosts = policy.rules.map((r) => r.host);
    expect(hosts).toContain("llm.gateway");
    expect(hosts).toContain("registry.npmjs.org");
  });

  it("is idempotent — applying the same preset twice adds no duplicates", () => {
    const config = makeConfig(tmpFile);
    applyPreset(BUILTIN_PRESETS["pypi"]!, config);
    const countAfterFirst = parsePolicyFile(tmpFile).rules.length;

    applyPreset(BUILTIN_PRESETS["pypi"]!, config);
    const countAfterSecond = parsePolicyFile(tmpFile).rules.length;

    expect(countAfterFirst).toBe(countAfterSecond);
  });
});

// ---------------------------------------------------------------------------
// removePreset
// ---------------------------------------------------------------------------

describe("removePreset", () => {
  it("removes rules added by a preset", () => {
    const config = makeConfig(tmpFile);
    applyPreset(BUILTIN_PRESETS["github"]!, config);

    // Verify github rules are present
    expect(
      parsePolicyFile(tmpFile).rules.some((r) => r.host === "github.com"),
    ).toBe(true);

    removePreset(BUILTIN_PRESETS["github"]!, config);

    expect(
      parsePolicyFile(tmpFile).rules.some((r) => r.host === "github.com"),
    ).toBe(false);
  });

  it("does not remove rules that were not added by the preset", () => {
    writeFileSync(
      tmpFile,
      `version: "1"\nname: base\ndefault: deny\nrules:\n  - host: llm.gateway\n    action: allow\n`,
      "utf8",
    );

    const config = makeConfig(tmpFile);
    applyPreset(BUILTIN_PRESETS["npm"]!, config);
    removePreset(BUILTIN_PRESETS["npm"]!, config);

    const policy = parsePolicyFile(tmpFile);
    expect(policy.rules.some((r) => r.host === "llm.gateway")).toBe(true);
  });

  it("is a no-op when the policy file does not exist", () => {
    const config = makeConfig("/nonexistent/path/policy.yaml");
    expect(() =>
      removePreset(BUILTIN_PRESETS["pypi"]!, config),
    ).not.toThrow();
  });
});
