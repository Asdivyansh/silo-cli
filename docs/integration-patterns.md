# Integration Patterns

> Practical reference for how different agent frameworks and HTTP clients work inside SILO's sandboxed environment.

---

## Overview

SILO makes external agents work through two complementary mechanisms:

1. **`http_proxy` / `https_proxy` env vars** — automatically set inside the container. Most HTTP clients route through these without any code changes.
2. **`llm.gateway` DNS alias** — resolves to the host machine, letting agents target `http://llm.gateway:8199` as their LLM endpoint.

This document covers how specific frameworks and libraries integrate with each mechanism.

---

## Python Agents

### requests / httpx / urllib3 / aiohttp

These libraries **automatically respect** the `http_proxy` and `https_proxy` environment variables set inside the container. No code changes needed — your existing code routes through the SILO proxy transparently.

> For `aiohttp`, pass `trust_env=True` to `ClientSession`.

### OpenAI Python SDK

Override the base URL to point at the proxy:

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://llm.gateway:8199/v1",
    api_key="sk-placeholder",  # Required by SDK, but proxy replaces it
)

response = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Hello from the sandbox!"}],
)
```

### Anthropic Python SDK

```python
from anthropic import Anthropic

client = Anthropic(
    base_url="http://llm.gateway:8199",
    api_key="sk-ant-placeholder",  # Proxy injects the real key
)

response = client.messages.create(
    model="claude-sonnet-4-20250514",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello from the sandbox!"}],
)
```

---

## Node.js Agents

Node's built-in `fetch` does **not** automatically use proxy env vars. Libraries like `axios` do. For the simplest path, use the OpenAI Node SDK with a base URL override:

```javascript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://llm.gateway:8199/v1",
  apiKey: "sk-placeholder", // Proxy injects the real key
});

const response = await client.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello from the sandbox!" }],
});
```

For raw `fetch`, point directly at the proxy: `fetch("http://llm.gateway:8199/v1/chat/completions", ...)`.

---

## LangChain / LangGraph

```python
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    model="gpt-4o",
    base_url="http://llm.gateway:8199/v1",
    api_key="sk-placeholder",
)

response = llm.invoke("What is the capital of France?")
```

For Anthropic, use `ChatAnthropic` with `anthropic_api_url="http://llm.gateway:8199"`. For LangGraph agents, tools execute inside the sandbox — fully isolated.

Set `LANGCHAIN_TRACING_V2=false` to disable external tracing (it would be blocked by policy anyway).

---

## Ollama / Local LLMs

During `silo onboard`, choose **Local** as the provider and set `Base URL` to your local server (e.g. `http://localhost:11434`). The proxy translates `llm.gateway` requests to your local server automatically:

```
Container → http://llm.gateway:8199/v1/chat/completions
         → Proxy forwards to → http://localhost:11434/v1/chat/completions
```

Agent code uses the same `base_url="http://llm.gateway:8199/v1"` pattern — no changes needed.

---

## Agents That Browse the Web

Rather than allowing all internet access, whitelist specific domains:

```bash
silo policy add "*.google.com" --comment "Google search"
silo policy add "*.wikipedia.org" --comment "Wikipedia"
silo policy add "*.github.com" --comment "GitHub"
```

Alternatively, start with **Strict mode** (chosen during `silo onboard`) and use the **interactive interceptor** — each unauthorized request triggers a real-time approve/deny prompt on the host terminal. See [Running External Agents](./sandbox-agents.md) for details.

---

## Multi-Agent on Shared Network

When running multiple agents with `silo start --name`, all containers share the `silo-sandbox-net` bridge network. Containers can reach each other by name (e.g. `curl http://silo-backend:9000`). All agents share the same egress policy but have isolated `/workspace` mounts. See [Multi-Agent Support](./multi-agent.md) for full details.

---

## Common Environment Variable Patterns

Quick reference for environment variables to set inside the container for different frameworks:

| Framework | Variables |
|---|---|
| **OpenAI SDK** | `OPENAI_BASE_URL=http://llm.gateway:8199/v1` `OPENAI_API_KEY=sk-placeholder` |
| **Anthropic SDK** | `ANTHROPIC_BASE_URL=http://llm.gateway:8199` `ANTHROPIC_API_KEY=sk-ant-placeholder` |
| **LangChain** | `OPENAI_API_BASE=http://llm.gateway:8199/v1` `OPENAI_API_KEY=sk-placeholder` |
| **curl** | Uses `http_proxy`/`https_proxy` automatically (already set) |
| **pip** | Uses `https_proxy` automatically (already set) |
| **npm** | Uses `https_proxy` automatically (already set) |
| **git** | Uses `http_proxy`/`https_proxy` automatically (already set) |

---

## Tips for Agent Authors

If you're building an agent that should work well inside SILO:

1. **Respect proxy env vars** — Use HTTP libraries that honor `http_proxy` / `https_proxy`
2. **Make the base URL configurable** — Allow users to override the LLM endpoint via env var
3. **Don't hardcode API keys** — Accept them via environment variable, not config files
4. **Handle HTTP 403 gracefully** — SILO returns 403 for blocked requests; don't crash on policy denials
5. **Minimize required network access** — The fewer hosts your agent needs, the easier it is to sandbox

---

*SILO v0.2.0 — Secure AI Agent Sandbox Orchestrator*
