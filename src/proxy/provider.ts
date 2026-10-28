/**
 * Provider routing: maps the configured LLM provider to its real base URL and
 * generates the auth headers that must be injected by the inference proxy.
 *
 * API keys are sourced exclusively from the host config — they are never
 * present in the Docker container environment.
 */
import type { LLMConfig, LLMProvider } from "../config/schema.js";

export interface ProviderTarget {
  /** The base URL to forward requests to, e.g. https://api.openai.com */
  baseUrl: string;
  /** Auth/meta headers that replace whatever the container sent */
  authHeaders: Record<string, string>;
}

/**
 * Static base URLs for managed providers.
 * These can be overridden per-request via `config.llm.baseUrl`.
 */
const PROVIDER_BASE_URLS: Record<LLMProvider, string> = {
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
  local: "http://localhost:11434",
};

/**
 * Resolve the upstream target and build the headers to inject.
 *
 * @param llm  The LLM section of SiloConfig
 * @returns    Target base URL and auth headers
 */
export function resolveProviderTarget(llm: LLMConfig): ProviderTarget {
  // Cache key: provider + apiKey + baseUrl — these don't change during a session
  const cacheKey = `${llm.provider}|${llm.apiKey}|${llm.baseUrl ?? ""}`;
  const cached = _providerCache.get(cacheKey);
  if (cached) return cached;

  const baseUrl = llm.baseUrl ?? PROVIDER_BASE_URLS[llm.provider];
  let result: ProviderTarget;

  switch (llm.provider) {
    case "openai":
      result = {
        baseUrl,
        authHeaders: {
          authorization: `Bearer ${llm.apiKey}`,
        },
      };
      break;

    case "anthropic":
      result = {
        baseUrl,
        authHeaders: {
          "x-api-key": llm.apiKey,
          "anthropic-version": "2023-06-01",
        },
      };
      break;

    case "local":
      // Most local servers (Ollama, LM Studio) accept a Bearer token.
      // When apiKey is the placeholder "local", omit the header entirely.
      result = {
        baseUrl,
        authHeaders:
          llm.apiKey && llm.apiKey !== "local"
            ? { authorization: `Bearer ${llm.apiKey}` }
            : {},
      };
      break;
  }

  _providerCache.set(cacheKey, result);
  return result;
}

/** Provider target cache — avoids re-allocating on every proxy request. */
const _providerCache = new Map<string, ProviderTarget>();

/**
 * Strip outgoing auth headers from the container request so the real key
 * cannot be leaked or forged by the sandboxed agent.
 */
export const STRIPPED_REQUEST_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "api-key",
  "openai-api-key",
  "anthropic-api-key",
]);
