/**
 * Tests for the egress gateway sidecar helpers.
 *
 * The Docker side effects (run/connect/rm) are exercised in integration
 * environments; these tests pin down the pure logic — alias derivation and
 * the config signature that decides when the sidecar must be rebuilt.
 */
import { describe, it, expect } from "vitest";
import {
  GATEWAY_CONTAINER,
  gatewayAliases,
  gatewayConfigSignature,
} from "../../src/docker/gateway.js";
import type { IntegrationConfig } from "../../src/config/schema.js";

function makeIntegration(gateway: string): IntegrationConfig {
  return {
    name: gateway.split(".")[0]!,
    baseUrl: `https://${gateway.split(".")[0]}.example.com`,
    gateway,
    authType: "bearer",
    token: "test-token",
  };
}

describe("gatewayAliases", () => {
  it("always includes llm.gateway", () => {
    expect(gatewayAliases([])).toEqual(["llm.gateway"]);
  });

  it("adds one alias per integration gateway", () => {
    const aliases = gatewayAliases([
      makeIntegration("slack.gateway"),
      makeIntegration("github.gateway"),
    ]);
    expect(aliases).toContain("llm.gateway");
    expect(aliases).toContain("slack.gateway");
    expect(aliases).toContain("github.gateway");
    expect(aliases).toHaveLength(3);
  });

  it("deduplicates repeated gateways", () => {
    const aliases = gatewayAliases([
      makeIntegration("slack.gateway"),
      makeIntegration("slack.gateway"),
    ]);
    expect(aliases).toHaveLength(2);
  });
});

describe("gatewayConfigSignature", () => {
  it("changes when the proxy port changes", () => {
    expect(gatewayConfigSignature(8199, [])).not.toBe(gatewayConfigSignature(9000, []));
  });

  it("changes when integrations change", () => {
    expect(gatewayConfigSignature(8199, [])).not.toBe(
      gatewayConfigSignature(8199, [makeIntegration("slack.gateway")]),
    );
  });

  it("is order-independent across integrations", () => {
    const a = gatewayConfigSignature(8199, [
      makeIntegration("slack.gateway"),
      makeIntegration("github.gateway"),
    ]);
    const b = gatewayConfigSignature(8199, [
      makeIntegration("github.gateway"),
      makeIntegration("slack.gateway"),
    ]);
    expect(a).toBe(b);
  });

  it("exposes a stable sidecar container name", () => {
    expect(GATEWAY_CONTAINER).toBe("silo-gateway");
  });
});
