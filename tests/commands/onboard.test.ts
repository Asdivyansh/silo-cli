import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit tests for the onboard command.
 *
 * We test the config-writing logic in isolation — the interactive inquirer
 * prompts are mocked so tests run non-interactively.
 */

// Mock config manager so tests never touch the real filesystem config
vi.mock("../../src/config/manager.js", () => ({
  readConfig: vi.fn(() => null),
  writeConfig: vi.fn(),
  configPath: vi.fn(() => "/tmp/test-config.json"),
}));

// Mock system checks to avoid requiring Docker in CI
vi.mock("../../src/utils/system.js", () => ({
  assertDockerAvailable: vi.fn(() => Promise.resolve()),
  isContainerRunning: vi.fn(() => Promise.resolve(false)),
  containerExists: vi.fn(() => Promise.resolve(false)),
  assertNodeVersion: vi.fn(),
  nodeVersion: vi.fn(() => "v20.0.0"),
}));

// Mock inquirer to return deterministic answers
vi.mock("inquirer", () => ({
  default: {
    prompt: vi.fn(),
  },
}));

// Mock ora so spinners don't emit ANSI to stdout
vi.mock("ora", () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
  })),
}));

// Mock fs so we don't create directories on disk
vi.mock("node:fs", () => ({ existsSync: vi.fn(() => true) }));
vi.mock("node:fs/promises", () => ({ mkdir: vi.fn(() => Promise.resolve()) }));

// Mock policy presets so we don't write policy files to disk
vi.mock("../../src/policy/presets.js", () => ({
  defaultPolicyPath: vi.fn(() => "/tmp/test-policy.yaml"),
  writePolicyFile: vi.fn(),
  applyPreset: vi.fn(() => "/tmp/test-policy.yaml"),
  getPreset: vi.fn(() => ({ name: "standard", description: "standard", rules: [] })),
}));

describe("onboard command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes a valid SiloConfig when given well-formed answers", async () => {
    const inquirer = (await import("inquirer")).default;
    const { writeConfig } = await import("../../src/config/manager.js");

    // Simulate wizard answers in sequence (6 steps)
    vi.mocked(inquirer.prompt)
      .mockResolvedValueOnce({ provider: "anthropic" })
      .mockResolvedValueOnce({ apiKey: "sk-ant-test-key-1234" })
      .mockResolvedValueOnce({ model: "claude-sonnet-4-6" })
      .mockResolvedValueOnce({ workspacePath: "/tmp/workspace" })
      .mockResolvedValueOnce({ cpuLimit: "1.0", memoryLimit: "512m" })
      .mockResolvedValueOnce({ securityMode: "strict" });

    const { runOnboard } = await import("../../src/commands/onboard.js");
    await runOnboard({ force: false });

    expect(writeConfig).toHaveBeenCalledOnce();
    const saved = (writeConfig as ReturnType<typeof vi.fn>).mock.calls[0][0];

    expect(saved.llm.provider).toBe("anthropic");
    expect(saved.llm.apiKey).toBe("sk-ant-test-key-1234");
    expect(saved.llm.model).toBe("claude-sonnet-4-6");
    expect(saved.sandbox.workspacePath).toBe("/tmp/workspace");
    expect(saved.sandbox.cpuLimit).toBe("1.0");
    expect(saved.sandbox.policyFile).toBe("/tmp/test-policy.yaml");
    expect(saved.version).toBe("1");
  });

  it("exits early when already configured and --force is not passed", async () => {
    const { readConfig, writeConfig } = await import("../../src/config/manager.js");
    (readConfig as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      version: "1",
      llm: { provider: "openai", apiKey: "sk-existing", model: "gpt-4o" },
      sandbox: { image: "silo-sandbox:latest", containerName: "silo-agent", workspacePath: "/tmp", cpuLimit: "1.0", memoryLimit: "512m" },
      proxy: { port: 8199, running: false },
    });

    const { runOnboard } = await import("../../src/commands/onboard.js");
    await runOnboard({ force: false });

    expect(writeConfig).not.toHaveBeenCalled();
  });
});
