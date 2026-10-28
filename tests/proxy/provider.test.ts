import { describe, it, expect } from "vitest";
import {
  resolveProviderTarget,
  STRIPPED_REQUEST_HEADERS,
} from "../../src/proxy/provider.js";
import type { LLMConfig } from "../../src/config/schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function llm(overrides: Partial<LLMConfig>): LLMConfig {
  return {
    provider: "openai",
    apiKey: "sk-test-key",
    model: "gpt-4o",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveProviderTarget
// ---------------------------------------------------------------------------

describe("resolveProviderTarget", () => {
  describe("openai", () => {
    it("uses the canonical OpenAI base URL", () => {
      const { baseUrl } = resolveProviderTarget(llm({ provider: "openai" }));
      expect(baseUrl).toBe("https://api.openai.com");
    });

    it("injects a Bearer token", () => {
      const { authHeaders } = resolveProviderTarget(
        llm({ provider: "openai", apiKey: "sk-abc" }),
      );
      expect(authHeaders["authorization"]).toBe("Bearer sk-abc");
    });

    it("respects a custom baseUrl override", () => {
      const { baseUrl } = resolveProviderTarget(
        llm({ provider: "openai", baseUrl: "https://proxy.example.com" }),
      );
      expect(baseUrl).toBe("https://proxy.example.com");
    });
  });

  describe("anthropic", () => {
    it("uses the canonical Anthropic base URL", () => {
      const { baseUrl } = resolveProviderTarget(llm({ provider: "anthropic" }));
      expect(baseUrl).toBe("https://api.anthropic.com");
    });

    it("injects x-api-key and anthropic-version headers", () => {
      const { authHeaders } = resolveProviderTarget(
        llm({ provider: "anthropic", apiKey: "sk-ant-xyz" }),
      );
      expect(authHeaders["x-api-key"]).toBe("sk-ant-xyz");
      expect(authHeaders["anthropic-version"]).toBe("2023-06-01");
    });

    it("does NOT inject an Authorization header for Anthropic", () => {
      const { authHeaders } = resolveProviderTarget(llm({ provider: "anthropic" }));
      expect(authHeaders["authorization"]).toBeUndefined();
    });
  });

  describe("local", () => {
    it("defaults to http://localhost:11434", () => {
      const { baseUrl } = resolveProviderTarget(
        llm({ provider: "local", apiKey: "local" }),
      );
      expect(baseUrl).toBe("http://localhost:11434");
    });

    it("uses a custom baseUrl for local providers", () => {
      const { baseUrl } = resolveProviderTarget(
        llm({ provider: "local", baseUrl: "http://192.168.1.5:8080" }),
      );
      expect(baseUrl).toBe("http://192.168.1.5:8080");
    });

    it("omits auth headers when apiKey is the placeholder 'local'", () => {
      const { authHeaders } = resolveProviderTarget(
        llm({ provider: "local", apiKey: "local" }),
      );
      expect(Object.keys(authHeaders)).toHaveLength(0);
    });

    it("injects a Bearer token when a real key is provided", () => {
      const { authHeaders } = resolveProviderTarget(
        llm({ provider: "local", apiKey: "real-key-123" }),
      );
      expect(authHeaders["authorization"]).toBe("Bearer real-key-123");
    });
  });
});

// ---------------------------------------------------------------------------
// STRIPPED_REQUEST_HEADERS
// ---------------------------------------------------------------------------

describe("STRIPPED_REQUEST_HEADERS", () => {
  it("covers all common auth header names", () => {
    expect(STRIPPED_REQUEST_HEADERS.has("authorization")).toBe(true);
    expect(STRIPPED_REQUEST_HEADERS.has("x-api-key")).toBe(true);
    expect(STRIPPED_REQUEST_HEADERS.has("api-key")).toBe(true);
  });

  it("does not strip non-auth headers", () => {
    expect(STRIPPED_REQUEST_HEADERS.has("content-type")).toBe(false);
    expect(STRIPPED_REQUEST_HEADERS.has("accept")).toBe(false);
  });
});
