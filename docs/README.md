# SILO Documentation

> Comprehensive documentation for SILO — the Secure AI Agent Sandbox Orchestrator.

## What is SILO?

SILO is a self-hosted security platform that sits **between your operating system and AI agents**. It lets you run powerful, autonomous agents — like CrewAI, LangGraph, Aider, OpenClaw, or your own custom framework — inside hardened Docker containers where they have full coding capabilities but **zero access** to your API keys, no unrestricted internet, and every action audited.

**The core idea:** Your agent doesn't know it's sandboxed. Standard `http_proxy` environment variables and a transparent inference proxy mean *any* HTTP-based agent works inside SILO with zero code modifications.

### What SILO Gives You

- **Run any agent framework securely** — CrewAI, LangGraph, Aider, SWE-Agent, OpenClaw, or your own
- **API keys never enter the container** — the proxy injects credentials at request time
- **Deny-all networking by default** — agents can only reach hosts you explicitly allow
- **Interactive interception** — approve or deny live outbound requests from the agent in real-time
- **Unified audit trail** — every LLM call, tool invocation, framework trace, and egress request logged
- **Framework trace collection** — agent lifecycle events (start/end, tool calls, delegation) in one timeline
- **Multi-agent support** — run multiple isolated agents sharing a single proxy
- **Built-in agent runner** — quick `silo run "task"` for simple use cases
- **Snapshots** — save and restore container state
- **One-command setup** — `silo quickstart` gets you from zero to sandbox

---

## Documentation Index

### 🚀 Start Here

| Document | Description |
|---|---|
| [**Getting Started**](./getting-started.md) | Prerequisites, installation, and your first sandbox run |
| [**Running External Agents**](./sandbox-agents.md) | Run CrewAI, LangGraph, Aider, and custom agents in SILO |
| [**Capability Profiles**](./capability-profiles.md) | Design note on `--desktop`, `--mount`, and sandboxed browser mode |

### 🔌 Integration

| Document | Description |
|---|---|
| [Integration Patterns](./integration-patterns.md) | Framework-specific integration: Python, Node.js, LangChain, Anthropic, Ollama |
| [**Integrations (APIs)**](./integrations.md) | Connect agents to Slack, GitHub, HubSpot, etc. — credential-managed API gateways |
| [Agent Runner](./agent-runner.md) | The built-in `silo run` LLM tool-calling loop for quick tasks |
| [Multi-Agent](./multi-agent.md) | Running multiple isolated agents simultaneously |

### 🔒 Security & Policy

| Document | Description |
|---|---|
| [Security Model](./security-model.md) | Defence-in-depth layers, threat model, and hardening details |
| [Policy Engine](./policy-engine.md) | YAML policy format, evaluation semantics, presets, and hot-reload |
| [Proxy & Networking](./proxy-and-networking.md) | Inference proxy internals, credential injection, CONNECT tunnels |

### 📚 Reference

| Document | Description |
|---|---|
| [CLI Reference](./cli-reference.md) | Complete reference for every command, flag, and option |
| [Architecture](./architecture.md) | System design, layer model, data flow, and component relationships |
| [Audit & Logging](./audit-and-logging.md) | Unified JSONL audit trail, traces, tool calls, log rotation, and forensics |
| [Configuration](./configuration.md) | Config schema, storage locations, and environment variables |
| [Development](./development.md) | Setting up the dev environment, testing, and building |
| [Troubleshooting](./troubleshooting.md) | Common issues and their solutions |

---

## Quick Links

- **First time?** → [Getting Started](./getting-started.md)
- **Running your own agent?** → [Running External Agents](./sandbox-agents.md)
- **Need browser/local-file capability details?** → [Capability Profiles](./capability-profiles.md)
- **Need a framework example?** → [Integration Patterns](./integration-patterns.md)
- **Need a command?** → [CLI Reference](./cli-reference.md)
- **Security questions?** → [Security Model](./security-model.md)
- **Writing custom policies?** → [Policy Engine](./policy-engine.md)
- **Contributing?** → [Development](./development.md)
- **Connecting to APIs?** → [Integrations](./integrations.md)

---

*SILO v0.2.0*
