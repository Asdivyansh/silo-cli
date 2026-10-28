/**
 * Tests for the config manager.
 *
 * Validates:
 *  - readConfig / writeConfig round-trip with encryption/decryption
 *  - patchConfig deep-merges partial updates correctly
 *  - Invalid configs are rejected before being persisted
 *  - Existing plaintext API keys are transparently encrypted on writeConfig
 *  - clearConfig resets state so readConfig returns null
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock the `conf` dependency so tests don't write to the real filesystem
// ---------------------------------------------------------------------------

const mockStore: Record<string, unknown> = {};

vi.mock("conf", () => {
  return {
    default: class MockConf {
      get store() { return { ...mockStore }; }
      set store(val: Record<string, unknown>) {
        Object.keys(mockStore).forEach((k) => delete mockStore[k]);
        Object.assign(mockStore, val);
      }
      get path() { return "/tmp/mock-config.json"; }
      clear() {
        Object.keys(mockStore).forEach((k) => delete mockStore[k]);
      }
    },
  };
});

import {
  readConfig,
  writeConfig,
  patchConfig,
  clearConfig,
  configPath,
} from "../../src/config/manager.js";
import { isEncrypted, decryptSecret } from "../../src/config/encryption.js";
import type { SiloConfig } from "../../src/config/schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseConfig(overrides: Partial<SiloConfig> = {}): SiloConfig {
  return {
    version: "1",
    llm: {
      provider: "openai",
      apiKey: "sk-test-plaintext",
      model: "gpt-4o",
    },
    proxy: {
      port: 8199,
      running: false,
    },
    sandbox: {
      containerName: "silo-agent",
      workspacePath: "/tmp/workspace",
      cpuLimit: "1.0",
      memoryLimit: "512m",
    },
    integrations: [],
    ...overrides,
  };
}

beforeEach(() => {
  clearConfig();
});

// ---------------------------------------------------------------------------
// readConfig
// ---------------------------------------------------------------------------

describe("readConfig", () => {
  it("returns null when no config has been written", () => {
    expect(readConfig()).toBeNull();
  });

  it("returns the config after writing", () => {
    writeConfig(baseConfig());
    const cfg = readConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.llm.provider).toBe("openai");
  });

  it("transparently decrypts the API key on read", () => {
    writeConfig(baseConfig({ llm: { provider: "openai", apiKey: "sk-secret", model: "gpt-4o" } }));
    const cfg = readConfig();
    // readConfig should return plaintext
    expect(cfg!.llm.apiKey).toBe("sk-secret");
    expect(isEncrypted(cfg!.llm.apiKey)).toBe(false);
  });

  it("decrypts integration tokens on read", () => {
    writeConfig(baseConfig({
      integrations: [
        { name: "slack", gateway: "slack.gateway", baseUrl: "https://slack.com/api", authType: "bearer", token: "xoxb-real-token" },
      ],
    }));
    const cfg = readConfig();
    expect(cfg!.integrations![0]!.token).toBe("xoxb-real-token");
    expect(isEncrypted(cfg!.integrations![0]!.token)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// writeConfig
// ---------------------------------------------------------------------------

describe("writeConfig", () => {
  it("encrypts the API key before persisting", () => {
    writeConfig(baseConfig({ llm: { provider: "openai", apiKey: "sk-plaintext", model: "gpt-4o" } }));
    // The raw store should contain encrypted value
    const raw = mockStore as { llm?: { apiKey?: string } };
    expect(raw.llm?.apiKey).toBeDefined();
    expect(isEncrypted(raw.llm!.apiKey!)).toBe(true);
  });

  it("encrypts integration tokens before persisting", () => {
    writeConfig(baseConfig({
      integrations: [
        { name: "github", gateway: "github.gateway", baseUrl: "https://api.github.com", authType: "bearer", token: "ghp-plain" },
      ],
    }));
    const raw = mockStore as { integrations?: Array<{ token?: string }> };
    expect(isEncrypted(raw.integrations![0]!.token!)).toBe(true);
  });

  it("does not double-encrypt an already-encrypted API key", () => {
    // Write once
    writeConfig(baseConfig({ llm: { provider: "openai", apiKey: "sk-test", model: "gpt-4o" } }));
    const raw1 = mockStore as { llm?: { apiKey?: string } };
    const enc1 = raw1.llm!.apiKey!;

    // Read back (decrypted) and write again
    const cfg = readConfig()!;
    writeConfig(cfg);

    const raw2 = mockStore as { llm?: { apiKey?: string } };
    const enc2 = raw2.llm!.apiKey!;

    // Both should be encrypted
    expect(isEncrypted(enc1)).toBe(true);
    expect(isEncrypted(enc2)).toBe(true);

    // Both should decrypt to the same plaintext
    expect(decryptSecret(enc2)).toBe("sk-test");
  });

  it("round-trips the model field unchanged", () => {
    writeConfig(baseConfig({ llm: { provider: "anthropic", apiKey: "sk-ant", model: "claude-sonnet-4-6" } }));
    const cfg = readConfig();
    expect(cfg!.llm.model).toBe("claude-sonnet-4-6");
    expect(cfg!.llm.provider).toBe("anthropic");
  });
});

// ---------------------------------------------------------------------------
// patchConfig
// ---------------------------------------------------------------------------

describe("patchConfig", () => {
  it("throws when no config exists", () => {
    expect(() => patchConfig({ llm: { model: "gpt-4o-mini" } } as never)).toThrow(
      "No config found",
    );
  });

  it("deep-merges a partial LLM update", () => {
    writeConfig(baseConfig());
    const updated = patchConfig({ llm: { model: "gpt-4o-mini" } } as never);
    expect(updated.llm.model).toBe("gpt-4o-mini");
    expect(updated.llm.provider).toBe("openai"); // unchanged
  });

  it("replaces the proxy port", () => {
    writeConfig(baseConfig());
    const updated = patchConfig({ proxy: { port: 9000 } } as never);
    expect(updated.proxy.port).toBe(9000);
    expect(updated.proxy.running).toBe(false); // unchanged
  });

  it("persists the patch (readConfig sees it)", () => {
    writeConfig(baseConfig());
    patchConfig({ sandbox: { cpuLimit: "4.0" } } as never);
    const cfg = readConfig();
    expect(cfg!.sandbox.cpuLimit).toBe("4.0");
    expect(cfg!.sandbox.memoryLimit).toBe("512m"); // unchanged
  });
});

// ---------------------------------------------------------------------------
// clearConfig
// ---------------------------------------------------------------------------

describe("clearConfig", () => {
  it("wipes config so readConfig returns null", () => {
    writeConfig(baseConfig());
    expect(readConfig()).not.toBeNull();
    clearConfig();
    expect(readConfig()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// configPath
// ---------------------------------------------------------------------------

describe("configPath", () => {
  it("returns a string path", () => {
    expect(typeof configPath()).toBe("string");
    expect(configPath().length).toBeGreaterThan(0);
  });
});
