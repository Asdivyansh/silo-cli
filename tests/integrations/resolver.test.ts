import { describe, it, expect } from "vitest";
import {
  resolveIntegrationTarget,
  isIntegrationGateway,
  findIntegration,
} from "../../src/integrations/resolver.js";
import type { IntegrationConfig } from "../../src/config/schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function integration(overrides: Partial<IntegrationConfig> = {}): IntegrationConfig {
  return {
    name: "test-service",
    baseUrl: "https://api.test.com",
    gateway: "test-service.gateway",
    authType: "bearer",
    token: "test-token-123",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveIntegrationTarget
// ---------------------------------------------------------------------------

describe("resolveIntegrationTarget", () => {
  describe("bearer auth", () => {
    it("injects Authorization: Bearer header", () => {
      const target = resolveIntegrationTarget(
        integration({ authType: "bearer", token: "xoxb-slack-token" }),
      );
      expect(target.authHeaders["authorization"]).toBe("Bearer xoxb-slack-token");
      expect(Object.keys(target.queryParams)).toHaveLength(0);
    });
  });

  describe("header auth", () => {
    it("injects the configured custom header", () => {
      const target = resolveIntegrationTarget(
        integration({
          authType: "header",
          authHeader: "x-api-key",
          token: "my-api-key",
        }),
      );
      expect(target.authHeaders["x-api-key"]).toBe("my-api-key");
      expect(target.authHeaders["authorization"]).toBeUndefined();
    });

    it("defaults to x-api-key when authHeader is not specified", () => {
      const target = resolveIntegrationTarget(
        integration({ authType: "header", token: "my-key" }),
      );
      expect(target.authHeaders["x-api-key"]).toBe("my-key");
    });
  });

  describe("query auth", () => {
    it("puts the token in queryParams", () => {
      const target = resolveIntegrationTarget(
        integration({
          authType: "query",
          authQueryParam: "api_key",
          token: "my-query-token",
        }),
      );
      expect(target.queryParams["api_key"]).toBe("my-query-token");
      expect(Object.keys(target.authHeaders)).toHaveLength(0);
    });

    it("defaults to api_key when authQueryParam is not specified", () => {
      const target = resolveIntegrationTarget(
        integration({ authType: "query", token: "tok" }),
      );
      expect(target.queryParams["api_key"]).toBe("tok");
    });
  });

  describe("extra headers", () => {
    it("merges extraHeaders into authHeaders", () => {
      const target = resolveIntegrationTarget(
        integration({
          authType: "bearer",
          token: "tok",
          extraHeaders: {
            "Notion-Version": "2022-06-28",
            "X-Custom": "value",
          },
        }),
      );
      expect(target.authHeaders["authorization"]).toBe("Bearer tok");
      expect(target.authHeaders["notion-version"]).toBe("2022-06-28");
      expect(target.authHeaders["x-custom"]).toBe("value");
    });
  });

  it("preserves the baseUrl from the integration config", () => {
    const target = resolveIntegrationTarget(
      integration({ baseUrl: "https://slack.com/api" }),
    );
    expect(target.baseUrl).toBe("https://slack.com/api");
  });
});

// ---------------------------------------------------------------------------
// isIntegrationGateway
// ---------------------------------------------------------------------------

describe("isIntegrationGateway", () => {
  const integrations = [
    integration({ name: "slack", gateway: "slack.gateway" }),
    integration({ name: "github", gateway: "github.gateway" }),
  ];

  it("returns true for a configured gateway hostname", () => {
    expect(isIntegrationGateway("slack.gateway", integrations)).toBe(true);
    expect(isIntegrationGateway("github.gateway", integrations)).toBe(true);
  });

  it("returns false for an unknown gateway", () => {
    expect(isIntegrationGateway("notion.gateway", integrations)).toBe(false);
    expect(isIntegrationGateway("llm.gateway", integrations)).toBe(false);
  });

  it("handles the host:port format correctly", () => {
    expect(isIntegrationGateway("slack.gateway:8199", integrations)).toBe(true);
    expect(isIntegrationGateway("unknown.gateway:8199", integrations)).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isIntegrationGateway("SLACK.GATEWAY", integrations)).toBe(true);
    expect(isIntegrationGateway("Slack.Gateway", integrations)).toBe(true);
  });

  it("returns false when integrations array is empty", () => {
    expect(isIntegrationGateway("slack.gateway", [])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// findIntegration
// ---------------------------------------------------------------------------

describe("findIntegration", () => {
  const slack = integration({ name: "slack", gateway: "slack.gateway" });
  const github = integration({ name: "github", gateway: "github.gateway" });
  const integrations = [slack, github];

  it("finds the correct integration for a matching gateway", () => {
    const found = findIntegration("slack.gateway", integrations);
    expect(found).toBe(slack);
  });

  it("finds with port suffix", () => {
    const found = findIntegration("github.gateway:8199", integrations);
    expect(found).toBe(github);
  });

  it("returns undefined for non-matching gateways", () => {
    expect(findIntegration("notion.gateway", integrations)).toBeUndefined();
    expect(findIntegration("llm.gateway", integrations)).toBeUndefined();
  });

  it("returns undefined when integrations array is empty", () => {
    expect(findIntegration("slack.gateway", [])).toBeUndefined();
  });
});
