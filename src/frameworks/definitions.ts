/**
 * Framework Definitions
 *
 * All supported agent frameworks with their install, policy, and
 * TUI metadata. Import this module to populate the registry.
 */
import { registerFramework } from "./registry.js";
import type { FrameworkDefinition } from "./registry.js";

// ---------------------------------------------------------------------------
// OpenClaw config JSON — baked into the Docker image at /etc/silo/openclaw.json
// ---------------------------------------------------------------------------
const OPENCLAW_CONFIG_JSON = JSON.stringify(
  {
    models: {
      mode: "replace",
      providers: {
        "silo-proxy": {
          baseUrl: "http://llm.gateway:8199/v1",
          apiKey: "silo-proxy-injected",
          models: [
            { id: "gpt-4o", name: "GPT-4o", api: "openai-completions" },
            { id: "gpt-4.1", name: "GPT-4.1", api: "openai-completions" },
            { id: "o4-mini", name: "o4-mini", api: "openai-completions" },
            {
              id: "claude-sonnet-4-20250514",
              name: "Claude Sonnet 4",
              api: "openai-completions",
            },
          ],
        },
      },
    },
    gateway: {
      mode: "local",
      bind: "loopback",
      auth: { mode: "none" },
      port: 18789,
    },
    agents: {
      defaults: {
        model: "silo-proxy/gpt-4o",
      },
    },
  },
);

const NODE_22_RUNTIME_SNIPPET = [
  "# Install Node.js 22 from the official Node image",
  "# Debian/Ubuntu apt packages can lag below agent CLI requirements.",
  "RUN apt-get update && apt-get install -y --no-install-recommends \\",
  "        libstdc++6 \\",
  "    && rm -rf /var/lib/apt/lists/* \\",
  "    && apt-get clean",
  "COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node",
  "COPY --from=node:22-bookworm-slim /usr/local/lib/node_modules /usr/local/lib/node_modules",
  "RUN ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \\",
  "    && ln -sf ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \\",
  "    && if [ -e /usr/local/lib/node_modules/corepack/dist/corepack.js ]; then \\",
  "         ln -sf ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack; \\",
  "       fi",
  `RUN node -e "const [maj,min]=process.versions.node.split('.').map(Number); if (maj < 22 || (maj === 22 && min < 19)) { console.error('Node.js 22.19+ required, found ' + process.version); process.exit(1); }" \\`,
  "    && node --version \\",
  "    && npm --version",
].join("\n");

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

const FRAMEWORK_DEFS: FrameworkDefinition[] = [
  {
    id: "crewai",
    name: "CrewAI",
    description: "Build and orchestrate multi-agent crews for complex task execution",
    version: "latest",
    install: {
      method: "pip",
      packages: ["crewai", "crewai-tools"],
    },
    requiredPolicies: ["pypi"],
    tuiCommand: null,
    healthCheck: "python3 -c \"import crewai; print('crewai', crewai.__version__)\"",
    entrypoint: null,
    envVars: { CREWAI_TELEMETRY: "false" },
    tags: ["multi-agent", "orchestration", "python"],
    docsUrl: "https://docs.crewai.com",
    icon: "🚢",
  },

  {
    id: "langgraph",
    name: "LangGraph",
    description: "Build stateful, multi-actor agent applications with LangChain",
    version: "latest",
    install: {
      method: "pip",
      packages: [
        "langgraph",
        "langchain",
        "langchain-openai",
        "langchain-anthropic",
        "langchain-community",
      ],
    },
    requiredPolicies: ["pypi"],
    tuiCommand: null,
    healthCheck: "python3 -c \"import langgraph; print('langgraph', langgraph.__version__)\"",
    entrypoint: null,
    tags: ["stateful", "graph", "python", "langchain"],
    docsUrl: "https://langchain-ai.github.io/langgraph/",
    icon: "🔀",
  },
  {
    id: "openclaw",
    name: "OpenClaw",
    description: "Powerful autonomous coding agent framework",
    version: "latest",
    install: {
      method: "custom",
      packages: [],
      dockerSnippet: [
        NODE_22_RUNTIME_SNIPPET,
        "RUN npm install -g openclaw@latest",
        "# Create writable home dir for the non-root agent user",
        "RUN mkdir -p /home/agent/.openclaw && chown -R 1001:1001 /home/agent",
        "# Bake SILO-managed OpenClaw config into the image",
        `RUN mkdir -p /etc/silo && echo '${OPENCLAW_CONFIG_JSON.replace(/'/g, "'\\''")}' > /etc/silo/openclaw.json`,
      ].join("\n"),
    },
    requiredPolicies: ["npm"],
    tuiCommand: "openclaw tui --session silo-$(date +%s)",
    healthCheck: "openclaw --version",
    entrypoint: null,
    // Copy read-only baked config to writable home, then start a durable gateway daemon.
    // Restart gateway if unhealthy or port is closed.
    prelaunchCommand:
      "mkdir -p ~/.openclaw/logs && cp /etc/silo/openclaw.json ~/.openclaw/openclaw.json && " +
      "(openclaw health >/dev/null 2>&1 || " +
      "((kill $(pgrep -f \"openclaw gateway run\" | grep -vx $$) 2>/dev/null || true) && " +
      "exec openclaw gateway run >> ~/.openclaw/logs/gateway.log 2>&1))",
    envVars: {
      HOME: "/home/agent",
      OPENCLAW_HEADLESS: "1",
      OPENCLAW_GATEWAY_TOKEN: "silo-managed",
      OPENCLAW_GATEWAY_PASSWORD: "silo-managed",
    },
    runtimeRequirements: {
      node: ">=22.19.0",
    },
    tmpfsMounts: ["/home/agent"],
    tmpfsMountSizes: { "/home/agent": "256m" },
    tags: ["coding", "autonomous", "node"],
    docsUrl: "https://openclaw.ai/docs",
    icon: "🦞",
  },
  {
    id: "aider",
    name: "Aider",
    description: "AI pair programming in your terminal — works with any LLM",
    version: "latest",
    install: {
      method: "pip",
      packages: ["aider-chat"],
    },
    requiredPolicies: ["pypi", "github"],
    tuiCommand: "aider",
    healthCheck: "aider --version",
    entrypoint: null,
    // Route LLM calls through the SILO proxy: the base URL targets
    // llm.gateway and the placeholder key is replaced by host-side
    // credential injection. HOME gets a tmpfs so aider can write its
    // ~/.aider cache/history on the read-only rootfs.
    envVars: {
      HOME: "/home/agent",
      OPENAI_API_BASE: "http://llm.gateway:8199/v1",
      OPENAI_API_KEY: "silo-proxy-injected",
    },
    tmpfsMounts: ["/home/agent"],
    tmpfsMountSizes: { "/home/agent": "128m" },
    tags: ["coding", "pair-programming", "python"],
    docsUrl: "https://aider.chat",
    icon: "🧑‍💻",
  },
  {
    id: "swe-agent",
    name: "SWE-Agent",
    description: "Princeton's agent for solving GitHub issues autonomously",
    version: "latest",
    install: {
      method: "pip",
      packages: ["swe-agent"],
      systemDeps: ["build-essential"],
    },
    requiredPolicies: ["pypi", "github"],
    tuiCommand: null,
    healthCheck: "python3 -c \"import sweagent; print('swe-agent ready')\"",
    entrypoint: null,
    tags: ["swe", "github", "python"],
    docsUrl: "https://swe-agent.com",
    icon: "🔧",
  },
];

// NOTE: Claude Code was removed as a built-in (v0.2): it is a first-party
// tool with its own permission system, outside SILO's untrusted-agent
// focus, and its subscription login needs a browser OAuth flow the sandbox
// deliberately lacks. Users who want it can register it as a custom
// framework via ~/.silo/frameworks/ (see docs/sandbox-agents.md).

// ---------------------------------------------------------------------------
// Auto-register all frameworks on import
// ---------------------------------------------------------------------------

for (const def of FRAMEWORK_DEFS) {
  registerFramework(def);
}

// User-provided definitions from ~/.silo/frameworks/ are loaded once at CLI
// startup (see cli.ts) so imports stay deterministic for tests.

export { FRAMEWORK_DEFS };
