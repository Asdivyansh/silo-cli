import { z } from "zod";

export const LLMProviderSchema = z.enum(["openai", "anthropic", "local"]);
export type LLMProvider = z.infer<typeof LLMProviderSchema>;

export const HostMountSchema = z.object({
  /** Absolute host path to expose to the sandbox */
  source: z.string().min(1),
  /** Absolute container path. Additional host mounts are restricted to /host/... */
  target: z.string().min(1).refine(
    (value) => value === "/host" || value.startsWith("/host/"),
    "host mount target must be /host or /host/...",
  ),
  /** Mount mode: read-only or read-write */
  mode: z.enum(["ro", "rw"]).default("rw"),
});
export type HostMount = z.infer<typeof HostMountSchema>;

export const SandboxConfigSchema = z.object({
  /** Docker image tag used for the agent sandbox */
  image: z.string().default("silo-sandbox:latest"),
  /** Container name on the host */
  containerName: z.string().default("silo-agent"),
  /** Absolute host path mounted into the container as /workspace (read-write) */
  workspacePath: z.string(),
  /** CPU limit, e.g. "1.0" */
  cpuLimit: z.string().default("1.0"),
  /** Memory limit, e.g. "512m" */
  memoryLimit: z.string().default("512m"),
  /** Path to the active YAML policy file */
  policyFile: z.string().optional(),
  /** Additional opt-in host paths mounted into the sandbox under /host */
  hostMounts: z.array(HostMountSchema).optional(),
  /** Active agent framework (e.g. "crewai", "langgraph") — null for plain sandbox */
  activeFramework: z.string().optional(),
});
export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;

export const LLMConfigSchema = z.object({
  provider: LLMProviderSchema,
  /** API key is stored encrypted at rest; never passed directly into the container */
  apiKey: z.string().min(1),
  /** Model name, e.g. "gpt-4o" or "claude-opus-4-6" */
  model: z.string(),
  /** Base URL override for local/custom providers */
  baseUrl: z.string().url().optional(),
});
export type LLMConfig = z.infer<typeof LLMConfigSchema>;

export const ProxyConfigSchema = z.object({
  /** Host port the inference proxy listens on */
  port: z.number().int().min(1024).max(65535).default(8199),
  /** Whether the proxy is currently running */
  running: z.boolean().default(false),
  /** Whether to auto-open logs in a new terminal window */
  autoOpenLogs: z.boolean().default(true),
});
export type ProxyConfig = z.infer<typeof ProxyConfigSchema>;

// ---------------------------------------------------------------------------
// Integration config
// ---------------------------------------------------------------------------

export const IntegrationAuthTypeSchema = z.enum(["bearer", "header", "query"]);
export type IntegrationAuthType = z.infer<typeof IntegrationAuthTypeSchema>;

export const IntegrationConfigSchema = z.object({
  /** Unique name for this integration (e.g. "slack", "hubspot") */
  name: z.string().min(1).regex(/^[a-z0-9-]+$/, "lowercase alphanumeric + hyphens only"),
  /** The real API base URL (e.g. "https://slack.com/api") */
  baseUrl: z.string().url(),
  /** Gateway hostname alias (e.g. "slack.gateway") — auto-generated from name */
  gateway: z.string(),
  /** Authentication method */
  authType: IntegrationAuthTypeSchema,
  /** The API token/key (stored host-side, never enters the container) */
  token: z.string().min(1),
  /** For authType="header": the header name (e.g. "x-api-key", "hapikey") */
  authHeader: z.string().optional(),
  /** For authType="query": the query parameter name (e.g. "api_key") */
  authQueryParam: z.string().optional(),
  /** Optional extra headers to inject (e.g. API version headers) */
  extraHeaders: z.record(z.string()).optional(),
  /** Human-readable description */
  description: z.string().optional(),
});
export type IntegrationConfig = z.infer<typeof IntegrationConfigSchema>;

// ---------------------------------------------------------------------------
// Root config
// ---------------------------------------------------------------------------

export const SiloConfigSchema = z.object({
  /** Schema version for forward-compatibility */
  version: z.literal("1").default("1"),
  llm: LLMConfigSchema,
  sandbox: SandboxConfigSchema,
  proxy: ProxyConfigSchema.default({}),
  /** Configured third-party integrations (credential-managed gateways) */
  integrations: z.array(IntegrationConfigSchema).default([]),
  /** Timestamp of last successful onboard */
  onboardedAt: z.string().datetime().optional(),
});
export type SiloConfig = z.infer<typeof SiloConfigSchema>;

/** Partial config used during onboard before all fields are set */
export const PartialSiloConfigSchema = SiloConfigSchema.deepPartial();
export type PartialSiloConfig = z.infer<typeof PartialSiloConfigSchema>;
