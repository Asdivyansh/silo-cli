/**
 * Integration Gateway Resolver
 *
 * Maps integration gateway hostnames (e.g. `slack.gateway`) to their upstream
 * API targets and generates the auth headers / query params to inject.
 *
 * This is the integration equivalent of `proxy/provider.ts` for LLM routing.
 * The proxy server calls into this module when it detects a request to an
 * integration gateway hostname.
 *
 * Security contract:
 *   - Tokens are sourced exclusively from the host config — they never enter
 *     the Docker container environment.
 *   - Container-sent auth headers are stripped before forwarding (handled by
 *     the proxy server using STRIPPED_REQUEST_HEADERS).
 */
import type { IntegrationConfig } from "../config/schema.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IntegrationTarget {
  /** The upstream base URL to forward requests to (e.g. "https://slack.com/api") */
  baseUrl: string;
  /** Auth and meta headers to inject into the outbound request */
  authHeaders: Record<string, string>;
  /** Query parameters to append (for authType="query") */
  queryParams: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve an integration config into its upstream target.
 *
 * Generates the correct auth headers or query params based on the
 * integration's `authType`:
 *   - "bearer"  → `Authorization: Bearer <token>`
 *   - "header"  → `<authHeader>: <token>`
 *   - "query"   → `?<authQueryParam>=<token>` appended to every request
 */
export function resolveIntegrationTarget(integration: IntegrationConfig): IntegrationTarget {
  const authHeaders: Record<string, string> = {};
  const queryParams: Record<string, string> = {};

  switch (integration.authType) {
    case "bearer":
      authHeaders["authorization"] = `Bearer ${integration.token}`;
      break;

    case "header": {
      const headerName = integration.authHeader ?? "x-api-key";
      authHeaders[headerName.toLowerCase()] = integration.token;
      break;
    }

    case "query": {
      const paramName = integration.authQueryParam ?? "api_key";
      queryParams[paramName] = integration.token;
      break;
    }
  }

  // Merge any extra headers defined on the integration (e.g. API version headers)
  if (integration.extraHeaders) {
    for (const [key, value] of Object.entries(integration.extraHeaders)) {
      authHeaders[key.toLowerCase()] = value;
    }
  }

  return {
    baseUrl: integration.baseUrl,
    authHeaders,
    queryParams,
  };
}

/**
 * Check whether a hostname matches any configured integration gateway.
 *
 * @param host  The bare hostname (without port), e.g. "slack.gateway"
 * @param integrations  The list of configured integrations
 */
export function isIntegrationGateway(
  host: string,
  integrations: IntegrationConfig[],
): boolean {
  return integrations.some((i) => matchesGateway(host, i.gateway));
}

/**
 * Find the integration config matching a given gateway hostname.
 * Returns undefined if no integration matches.
 *
 * @param host  The bare hostname (without port), e.g. "slack.gateway"
 * @param integrations  The list of configured integrations
 */
export function findIntegration(
  host: string,
  integrations: IntegrationConfig[],
): IntegrationConfig | undefined {
  return integrations.find((i) => matchesGateway(host, i.gateway));
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Match a request hostname against a gateway alias.
 * Handles the case where the hostname may include a port suffix (e.g. "slack.gateway:8199").
 */
function matchesGateway(host: string, gateway: string): boolean {
  const bareHost = host.replace(/:\d+$/, "");
  return bareHost.toLowerCase() === gateway.toLowerCase();
}
