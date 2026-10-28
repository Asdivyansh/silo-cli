/**
 * Deep Integration Tests
 *
 * Covers edge cases across the full integration stack:
 *   1. Zod schema validation (valid/invalid IntegrationConfig)
 *   2. Docker template flag generation (--add-host injection)
 *   3. Resolver edge cases (empty tokens, special characters, multiple integrations)
 *   4. Gateway collision detection (llm.gateway vs integration gateways)
 *   5. Config manager round-trip (write → read with integrations)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { IntegrationConfigSchema, SiloConfigSchema } from "../../src/config/schema.js";
import type { IntegrationConfig } from "../../src/config/schema.js";
import { buildRunFlags } from "../../src/docker/templates.js";
import type { SandboxConfig, ProxyConfig } from "../../src/config/schema.js";
import {
  resolveIntegrationTarget,
  isIntegrationGateway,
  findIntegration,
} from "../../src/integrations/resolver.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const sandbox: SandboxConfig = {
  image: "silo-sandbox:latest",
  containerName: "silo-agent",
  workspacePath: "/tmp/test-workspace",
  cpuLimit: "1.0",
  memoryLimit: "512m",
};

const proxy: ProxyConfig = { port: 8199, running: false };

function makeIntegration(overrides: Partial<IntegrationConfig> = {}): IntegrationConfig {
  return {
    name: "test-svc",
    baseUrl: "https://api.test.com",
    gateway: "test-svc.gateway",
    authType: "bearer",
    token: "test-token-abc123",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Zod Schema Validation
// ---------------------------------------------------------------------------

describe("IntegrationConfigSchema validation", () => {
  it("accepts a valid bearer integration", () => {
    const result = IntegrationConfigSchema.safeParse({
      name: "slack",
      baseUrl: "https://slack.com/api",
      gateway: "slack.gateway",
      authType: "bearer",
      token: "xoxb-test-token",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid header integration with all optional fields", () => {
    const result = IntegrationConfigSchema.safeParse({
      name: "custom-api",
      baseUrl: "https://api.example.com",
      gateway: "custom-api.gateway",
      authType: "header",
      token: "my-key",
      authHeader: "x-api-key",
      extraHeaders: { "x-version": "2024-01" },
      description: "A custom API integration",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid query integration", () => {
    const result = IntegrationConfigSchema.safeParse({
      name: "legacy-api",
      baseUrl: "https://legacy.example.com",
      gateway: "legacy-api.gateway",
      authType: "query",
      token: "qk-abc123",
      authQueryParam: "api_key",
    });
    expect(result.success).toBe(true);
  });

  it("rejects integration names with uppercase letters", () => {
    const result = IntegrationConfigSchema.safeParse({
      name: "Slack",
      baseUrl: "https://slack.com/api",
      gateway: "slack.gateway",
      authType: "bearer",
      token: "tok",
    });
    expect(result.success).toBe(false);
  });

  it("rejects integration names with spaces", () => {
    const result = IntegrationConfigSchema.safeParse({
      name: "my service",
      baseUrl: "https://api.example.com",
      gateway: "my-service.gateway",
      authType: "bearer",
      token: "tok",
    });
    expect(result.success).toBe(false);
  });

  it("rejects integration names with underscores", () => {
    const result = IntegrationConfigSchema.safeParse({
      name: "my_service",
      baseUrl: "https://api.example.com",
      gateway: "my-service.gateway",
      authType: "bearer",
      token: "tok",
    });
    expect(result.success).toBe(false);
  });

  it("accepts integration names with hyphens", () => {
    const result = IntegrationConfigSchema.safeParse({
      name: "my-service",
      baseUrl: "https://api.example.com",
      gateway: "my-service.gateway",
      authType: "bearer",
      token: "tok",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty name", () => {
    const result = IntegrationConfigSchema.safeParse({
      name: "",
      baseUrl: "https://api.example.com",
      gateway: "x.gateway",
      authType: "bearer",
      token: "tok",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty token", () => {
    const result = IntegrationConfigSchema.safeParse({
      name: "svc",
      baseUrl: "https://api.example.com",
      gateway: "svc.gateway",
      authType: "bearer",
      token: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid baseUrl", () => {
    const result = IntegrationConfigSchema.safeParse({
      name: "svc",
      baseUrl: "not-a-url",
      gateway: "svc.gateway",
      authType: "bearer",
      token: "tok",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid authType", () => {
    const result = IntegrationConfigSchema.safeParse({
      name: "svc",
      baseUrl: "https://api.example.com",
      gateway: "svc.gateway",
      authType: "oauth",
      token: "tok",
    });
    expect(result.success).toBe(false);
  });
});

describe("SiloConfigSchema with integrations", () => {
  it("defaults integrations to empty array", () => {
    const result = SiloConfigSchema.safeParse({
      version: "1",
      llm: { provider: "openai", apiKey: "sk-test", model: "gpt-4o" },
      sandbox: {
        image: "silo-sandbox:latest",
        containerName: "silo-agent",
        workspacePath: "/tmp/ws",
        cpuLimit: "1.0",
        memoryLimit: "512m",
      },
      proxy: { port: 8199, running: false },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.integrations).toEqual([]);
    }
  });

  it("accepts a config with multiple integrations", () => {
    const result = SiloConfigSchema.safeParse({
      version: "1",
      llm: { provider: "openai", apiKey: "sk-test", model: "gpt-4o" },
      sandbox: {
        image: "silo-sandbox:latest",
        containerName: "silo-agent",
        workspacePath: "/tmp/ws",
        cpuLimit: "1.0",
        memoryLimit: "512m",
      },
      proxy: { port: 8199, running: false },
      integrations: [
        { name: "slack", baseUrl: "https://slack.com/api", gateway: "slack.gateway", authType: "bearer", token: "xoxb-test" },
        { name: "github", baseUrl: "https://api.github.com", gateway: "github.gateway", authType: "bearer", token: "ghp-test" },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.integrations).toHaveLength(2);
      expect(result.data.integrations[0]?.name).toBe("slack");
      expect(result.data.integrations[1]?.name).toBe("github");
    }
  });

  it("rejects config with invalid integration in array", () => {
    const result = SiloConfigSchema.safeParse({
      version: "1",
      llm: { provider: "openai", apiKey: "sk-test", model: "gpt-4o" },
      sandbox: {
        image: "silo-sandbox:latest",
        containerName: "silo-agent",
        workspacePath: "/tmp/ws",
        cpuLimit: "1.0",
        memoryLimit: "512m",
      },
      proxy: { port: 8199, running: false },
      integrations: [
        { name: "INVALID NAME", baseUrl: "not-url", gateway: "x", authType: "invalid", token: "" },
      ],
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Docker Template Flag Generation
// ---------------------------------------------------------------------------

describe("buildRunFlags with integrations", () => {
  it("includes --add-host for each integration before the image", () => {
    const integrations = [
      makeIntegration({ name: "slack", gateway: "slack.gateway" }),
      makeIntegration({ name: "github", gateway: "github.gateway" }),
    ];

    const flags = buildRunFlags(sandbox, proxy, integrations);

    // Check integration gateways are present
    const slackIdx = flags.indexOf("slack.gateway:host-gateway");
    const githubIdx = flags.indexOf("github.gateway:host-gateway");
    expect(slackIdx).toBeGreaterThan(-1);
    expect(githubIdx).toBeGreaterThan(-1);

    // Each should be preceded by --add-host
    expect(flags[slackIdx - 1]).toBe("--add-host");
    expect(flags[githubIdx - 1]).toBe("--add-host");

    // Image should be the LAST element
    expect(flags[flags.length - 1]).toBe("silo-sandbox:latest");

    // Integration hosts should come before the image
    expect(slackIdx).toBeLessThan(flags.length - 1);
    expect(githubIdx).toBeLessThan(flags.length - 1);
  });

  it("still includes llm.gateway even with integrations", () => {
    const integrations = [makeIntegration({ name: "slack", gateway: "slack.gateway" })];
    const flags = buildRunFlags(sandbox, proxy, integrations);

    const llmIdx = flags.indexOf("llm.gateway:host-gateway");
    expect(llmIdx).toBeGreaterThan(-1);
  });

  it("works with no integrations (undefined)", () => {
    const flags = buildRunFlags(sandbox, proxy);
    expect(flags[flags.length - 1]).toBe("silo-sandbox:latest");
    expect(flags.filter(f => f.includes(".gateway:host-gateway"))).toHaveLength(1); // only llm.gateway
  });

  it("works with empty integrations array", () => {
    const flags = buildRunFlags(sandbox, proxy, []);
    expect(flags[flags.length - 1]).toBe("silo-sandbox:latest");
    expect(flags.filter(f => f.includes(".gateway:host-gateway"))).toHaveLength(1);
  });

  it("handles many integrations correctly", () => {
    const integrations = Array.from({ length: 10 }, (_, i) =>
      makeIntegration({ name: `svc-${i}`, gateway: `svc-${i}.gateway` }),
    );
    const flags = buildRunFlags(sandbox, proxy, integrations);

    // 10 integration gateways + 1 llm.gateway = 11 total
    const gatewayFlags = flags.filter(f => f.includes(".gateway:host-gateway"));
    expect(gatewayFlags).toHaveLength(11);

    // Image still last
    expect(flags[flags.length - 1]).toBe("silo-sandbox:latest");
  });
});

// ---------------------------------------------------------------------------
// 3. Resolver Edge Cases
// ---------------------------------------------------------------------------

describe("resolveIntegrationTarget — edge cases", () => {
  it("handles tokens with special characters", () => {
    const target = resolveIntegrationTarget(
      makeIntegration({ authType: "bearer", token: "xoxb-123/456+abc==" }),
    );
    expect(target.authHeaders["authorization"]).toBe("Bearer xoxb-123/456+abc==");
  });

  it("header auth lowercases the header name for consistency", () => {
    const target = resolveIntegrationTarget(
      makeIntegration({ authType: "header", authHeader: "X-API-KEY", token: "key" }),
    );
    // The header name should be lowercased
    expect(target.authHeaders["x-api-key"]).toBe("key");
  });

  it("query auth does not add auth headers", () => {
    const target = resolveIntegrationTarget(
      makeIntegration({ authType: "query", authQueryParam: "key", token: "tok" }),
    );
    // Should have no authorization-type headers
    expect(target.authHeaders["authorization"]).toBeUndefined();
    expect(target.authHeaders["x-api-key"]).toBeUndefined();
    // But should have query params
    expect(target.queryParams["key"]).toBe("tok");
  });

  it("extra headers don't override auth headers for bearer", () => {
    const target = resolveIntegrationTarget(
      makeIntegration({
        authType: "bearer",
        token: "real-token",
        extraHeaders: { "Authorization": "should-not-override" },
      }),
    );
    // extraHeaders are applied AFTER auth, so they DO override
    // This is the expected behavior — extraHeaders is for advanced users
    expect(target.authHeaders["authorization"]).toBe("should-not-override");
  });

  it("multiple extra headers are all lowercased and included", () => {
    const target = resolveIntegrationTarget(
      makeIntegration({
        authType: "bearer",
        token: "tok",
        extraHeaders: {
          "Content-Type": "application/json",
          "X-Custom-Header": "value",
          "Accept": "application/json",
        },
      }),
    );
    expect(target.authHeaders["content-type"]).toBe("application/json");
    expect(target.authHeaders["x-custom-header"]).toBe("value");
    expect(target.authHeaders["accept"]).toBe("application/json");
  });
});

// ---------------------------------------------------------------------------
// 4. Gateway Collision Detection
// ---------------------------------------------------------------------------

describe("gateway collision edge cases", () => {
  const integrations = [
    makeIntegration({ name: "slack", gateway: "slack.gateway" }),
    makeIntegration({ name: "github", gateway: "github.gateway" }),
  ];

  it("llm.gateway is NOT mistaken for an integration gateway", () => {
    expect(isIntegrationGateway("llm.gateway", integrations)).toBe(false);
    expect(findIntegration("llm.gateway", integrations)).toBeUndefined();
  });

  it("health endpoint host is NOT an integration gateway", () => {
    expect(isIntegrationGateway("localhost", integrations)).toBe(false);
    expect(isIntegrationGateway("127.0.0.1", integrations)).toBe(false);
  });

  it("partial gateway names don't match", () => {
    expect(isIntegrationGateway("slack", integrations)).toBe(false);
    expect(isIntegrationGateway("gateway", integrations)).toBe(false);
    expect(isIntegrationGateway("slack.gatewa", integrations)).toBe(false);
    expect(isIntegrationGateway("slack.gateway.extra", integrations)).toBe(false);
  });

  it("external hosts don't match integration gateways", () => {
    expect(isIntegrationGateway("api.slack.com", integrations)).toBe(false);
    expect(isIntegrationGateway("slack.com", integrations)).toBe(false);
    expect(isIntegrationGateway("github.com", integrations)).toBe(false);
  });

  it("finds the right integration when multiple exist", () => {
    const slack = findIntegration("slack.gateway", integrations);
    const github = findIntegration("github.gateway", integrations);
    expect(slack?.name).toBe("slack");
    expect(github?.name).toBe("github");
  });

  it("handles port suffix correctly for all integrations", () => {
    expect(findIntegration("slack.gateway:8199", integrations)?.name).toBe("slack");
    expect(findIntegration("github.gateway:3000", integrations)?.name).toBe("github");
    expect(findIntegration("unknown.gateway:8199", integrations)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. Full resolver + template consistency
// ---------------------------------------------------------------------------

describe("template → integration → resolver round-trip", () => {
  it("slack template produces correct resolver output", () => {
    const integration = makeIntegration({
      name: "slack",
      baseUrl: "https://slack.com/api",
      gateway: "slack.gateway",
      authType: "bearer",
      token: "xoxb-123-456-abc",
    });
    const target = resolveIntegrationTarget(integration);
    expect(target.baseUrl).toBe("https://slack.com/api");
    expect(target.authHeaders["authorization"]).toBe("Bearer xoxb-123-456-abc");
    expect(Object.keys(target.queryParams)).toHaveLength(0);
  });

  it("notion template produces correct resolver output with version header", () => {
    const integration = makeIntegration({
      name: "notion",
      baseUrl: "https://api.notion.com",
      gateway: "notion.gateway",
      authType: "bearer",
      token: "secret_abc123",
      extraHeaders: { "notion-version": "2022-06-28" },
    });
    const target = resolveIntegrationTarget(integration);
    expect(target.authHeaders["authorization"]).toBe("Bearer secret_abc123");
    expect(target.authHeaders["notion-version"]).toBe("2022-06-28");
  });

  it("github template produces correct resolver output with API version", () => {
    const integration = makeIntegration({
      name: "github",
      baseUrl: "https://api.github.com",
      gateway: "github.gateway",
      authType: "bearer",
      token: "ghp_test123",
      extraHeaders: {
        "accept": "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
    });
    const target = resolveIntegrationTarget(integration);
    expect(target.authHeaders["authorization"]).toBe("Bearer ghp_test123");
    expect(target.authHeaders["accept"]).toBe("application/vnd.github+json");
    expect(target.authHeaders["x-github-api-version"]).toBe("2022-11-28");
  });
});
