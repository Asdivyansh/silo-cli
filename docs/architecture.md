# Architecture

> Deep-dive into SILO's system design, layer model, data flow, and component relationships.

---

## High-Level Architecture

SILO is composed of four loosely-coupled layers that form a secure, observable pipeline from user intent to LLM response:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  HOST MACHINE                                                               │
│                                                                             │
│  ┌──────────────────────┐        ┌─────────────────────────────────────┐   │
│  │   silo CLI            │ start  │   Inference Proxy (:8199)           │   │
│  │   (Node.js)           │───────▶│   • Injects real API key            │   │
│  │                       │        │   • Evaluates policy per-request     │   │
│  │   $ silo start        │        │   • Records audit trail              │   │
│  │   $ silo run "task"   │        │   • Health check + auto-restart      │   │
│  │   $ silo logs         │        └────────────┬────────────────────────┘   │
│  └──────────────────────┘                      │ forwards to               │
│                                    ┌───────────▼──────────────────────┐     │
│                                    │   OpenAI / Anthropic / Ollama     │     │
│                                    └──────────────────────────────────┘     │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Docker Sandbox                                                     │   │
│  │  --read-only --cap-drop ALL --user 1001:1001 --pids-limit 128       │   │
│  │  --network silo-sandbox-net (SILO bridge)                           │   │
│  │                                                                     │   │
│  │  Agent code ──▶ http://llm.gateway:8199 ──▶ Proxy (on host)         │   │
│  │                                                                     │   │
│  │  ✓ HTTP egress routes through the policy proxy                      │   │
│  │  ✗ Cannot see API keys                                              │   │
│  │  ✗ Cannot escalate privileges                                       │   │
│  │  ✗ Cannot modify the root filesystem                                │   │
│  │  ✓ Can call LLMs through the proxy                                  │   │
│  │  ✓ Can read/write /workspace                                        │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## The Four Layers

### Layer 1 — CLI (`src/cli.ts` + `src/commands/`)

The user-facing surface built with **Commander.js** for argument parsing and **Inquirer.js** for the interactive onboard wizard.

**Entry point:** `src/cli.ts` — registers all commands, sets up global error handling, and parses `process.argv`.

**Command lifecycle (example: `silo start`):**

```
silo start
  │
  ├─ readConfig()            Read config from disk (via conf)
  ├─ assertDockerAvailable() docker info (smoke test)
  ├─ isContainerRunning()    docker inspect (guard against duplicates)
  ├─ ensureSiloNetwork()     docker network create (internal on native Linux)
  ├─ ensureProxyDaemon()     Spawn proxy process (detached)
  └─ startContainer()        docker run [hardened flags]
```

**Source files:**

| File | Responsibility |
|---|---|
| `src/cli.ts` | Commander program setup, command registration, global error handler |
| `src/commands/onboard.ts` | Interactive setup wizard (Inquirer.js prompts) |
| `src/commands/build.ts` | Docker image build orchestration |
| `src/commands/start.ts` | Stack launcher (network + proxy + container) |
| `src/commands/stop.ts` | Stack teardown (container + proxy + network cleanup) |
| `src/commands/connect.ts` | Interactive shell via `docker exec -it` |
| `src/commands/run.ts` | Agent task runner (LLM tool-calling loop, proxy-routed) |
| `src/commands/list.ts` | List running agents via Docker labels |
| `src/commands/status.ts` | Health dashboard (LLM, sandbox, policy, proxy, audit) |
| `src/commands/policy.ts` | Policy management subcommands |
| `src/commands/integrations.ts` | Integration management (add/list/remove/test/templates) |
| `src/commands/logs.ts` | Audit log viewer with filters and `--follow` live tail |

---

### Layer 2 — Docker Sandbox Runtime (`sandbox/`, `src/docker/`)

The agent process runs inside a hardened Docker container built from `sandbox/Dockerfile`.

**Image base:** `python:3.12-slim`

**Dockerfile stages:**
1. Create non-root user `agent` (UID/GID 1001)
2. Install minimal OS tooling (`curl`, `git`, `jq`, `ca-certificates`)
3. Copy `entrypoint.sh` (validates non-root, prints proxy config, loads skill scripts)
4. Create `/workspace` and `/skills` mount points
5. Switch to non-root user, set `WORKDIR /workspace`
6. Entrypoint runs `tail -f /dev/null` to keep the container alive for `docker exec`

**Runtime hardening flags** (applied by `src/docker/templates.ts`):

| Flag | Security Effect |
|---|---|
| `--user 1001:1001` | Non-root execution |
| `--read-only` | Immutable root filesystem |
| `--tmpfs /tmp:size=64m,noexec,nosuid` | Ephemeral scratch (no binary execution from /tmp) |
| `--cap-drop ALL` | All Linux capabilities dropped |
| `--security-opt no-new-privileges` | Blocks setuid/setgid escalation |
| `--pids-limit 128` | Fork-bomb prevention |
| `--cpus <n>` / `--memory <m>` | Resource throttles (from config) |
| `--network silo-sandbox-net` | SILO bridge network (internal on native Linux, standard bridge on Docker Desktop) |
| `--add-host llm.gateway:host-gateway` | Resolve `llm.gateway` to host IP |
| `--add-host <svc>.gateway:host-gateway` | Resolve integration gateways to host IP |
| `--label managed-by=silo` | Discovery label for `silo list` |

**Environment variables injected:**

| Variable | Value | Purpose |
|---|---|---|
| `http_proxy` / `HTTP_PROXY` | `http://llm.gateway:<port>` | Route HTTP through proxy |
| `https_proxy` / `HTTPS_PROXY` | `http://llm.gateway:<port>` | Route HTTPS through proxy |
| `no_proxy` / `NO_PROXY` | `localhost,127.0.0.1,::1` | Bypass proxy for loopback |
| `SILO_SANDBOX` | `1` | Indicates SILO sandbox mode |

**Volume mounts:**

| Host Path | Container Path | Mode |
|---|---|---|
| `config.sandbox.workspacePath` | `/workspace` | `rw` |

**Source files:**

| File | Responsibility |
|---|---|
| `src/docker/templates.ts` | `buildRunFlags()` — generates the complete `docker run` argument array |
| `src/docker/runner.ts` | Container lifecycle: `startContainer()`, `stopContainer()`, `inspectContainer()`, `containerStats()` |

---

### Layer 3 — Inference Proxy (`src/proxy/`)

A lightweight HTTP proxy that runs on the host machine on port `8199` (configurable). It operates as a **detached daemon process** spawned by `silo start` and managed via a PID file.

**Architecture:**

```
Agent (container)
  │  POST http://llm.gateway:8199/v1/chat/completions
  │  Authorization: (none — stripped by proxy)
  │
  ▼
Proxy (:8199)
  │
  ├─ Is this llm.gateway? ──▶ yes → Forward to real LLM provider
  │                               ├─ Strip container auth headers
  │                               ├─ Inject real API key
  │                               ├─ Rewrite Host header
  │                               └─ Stream response back + audit
  │
  ├─ Is this <svc>.gateway? ──▶ yes → Forward to integration API
  │                               ├─ Strip container auth headers
  │                               ├─ Inject real API token
  │                               └─ Audit with category=integration
  │
  ├─ Policy check (Layer 4) ──▶ allow → Forward as plain HTTP proxy hop + audit
  │
  └─ Policy = deny ──▶ TUI Interceptor
                        ├─ Allow once   → Forward this request only
                        ├─ Allow always → Add to policy + forward
                        └─ Deny         → Return 403 + audit
```

**Request types handled:**

| Request Type | Handler | Description |
|---|---|---|
| HTTP proxy (GET/POST/etc.) | `handleHttpRequest()` | Standard HTTP proxy requests |
| HTTPS CONNECT tunnel | `handleConnectTunnel()` | TCP tunnels for HTTPS destinations |
| Health check (`GET /_silo/health`) | Inline | Returns `{"status":"ok","pid":…,"uptimeMs":…}` |
| List Prompts (`GET /_silo/prompts`) | Inline | Returns JSON array of queued authorization prompts |
| Submit Decision (`POST /_silo/prompts/:id/decision`) | Inline | Submits a policy decision for a queued prompt |

**Key behaviours:**

1. **Auth header stripping** — All auth headers from the container (`authorization`, `x-api-key`, `api-key`, `openai-api-key`, `anthropic-api-key`) are stripped before forwarding to prevent credential forgery.
2. **CONNECT to llm.gateway is rejected** — Forces the agent to use plain HTTP so the proxy can inspect and audit the request body.
3. **Response streaming** — Responses are piped through without buffering, supporting SSE and chunked LLM outputs.
4. **Token usage extraction** — LLM response bodies are buffered in parallel to extract token usage for audit entries.

**Daemon lifecycle:**

| Event | Behaviour |
|---|---|
| `silo start` | Spawns daemon detached (`child.unref()`), writes PID file |
| `SIGHUP` | Hot-reloads the policy from disk without restarting |
| `SIGTERM` | Graceful shutdown: logs `session_stop`, closes server, clears PID file |
| `SIGINT` | Same as SIGTERM |
| Crash | Detected by `silo connect`/`silo run` via health check, auto-restarted |

**Source files:**

| File | Responsibility |
|---|---|
| `src/proxy/server.ts` | HTTP/CONNECT proxy server, request routing, health endpoint |
| `src/proxy/daemon.ts` | Daemon entry point (bootstrap, signal handlers, policy reload) |
| `src/proxy/provider.ts` | Provider routing + auth header injection (OpenAI, Anthropic, Local) |
| `src/proxy/interceptor.ts` | TUI approve/deny prompt; persists "allow always" to policy YAML |
| `src/proxy/spawn.ts` | Shared daemon spawn logic (used by `start.ts` and `health.ts`) |
| `src/integrations/templates.ts` | Built-in integration templates (Slack, GitHub, HubSpot, etc.) |
| `src/integrations/resolver.ts` | Integration gateway → upstream URL + auth header resolution |

---

### Layer 4 — Policy Engine (`src/policy/`)

A YAML-based declarative policy system that controls which outbound hosts the sandboxed agent can reach.

**Evaluation algorithm:**

```
for rule in policy.rules:
    if glob_match(rule.host, request.host):
        return rule.action    # "allow" or "deny"

return policy.default         # fallback when no rule matches
```

Rules are evaluated **top-to-bottom** — the first match wins. Glob patterns follow picomatch semantics.

**Compilation:** Policies are compiled into pre-built picomatch matchers once on load/reload via `compilePolicy()`. The compiled form is passed to the server for fast per-request evaluation via `evaluateCompiled()` — no regex compilation in the hot path.

**Hot-reload:** On `SIGHUP` (or programmatic triggers), the daemon re-reads and recompiles the policy YAML file without restarting the proxy or dropping connections.

**Source files:**

| File | Responsibility |
|---|---|
| `src/policy/engine.ts` | YAML parser, Zod validation, picomatch compilation, evaluation |
| `src/policy/presets.ts` | Built-in preset registry, apply/remove/merge operations |

---

## End-to-End Data Flow

```
User terminal
    │
    │  $ silo run "Install numpy and test it"
    ▼
┌──────────────────────────────────┐
│  CLI (Layer 1)                   │
│  readConfig → assertDocker       │
│  → ensureProxyRunning            │
│  → callLlm (via proxy at       │
│     127.0.0.1:port — audited)   │
│  → executeInContainer            │
│     (docker exec --workdir       │
│      /workspace silo-agent       │
│      /bin/sh -c "pip install…") │
│  → feed result back to LLM      │
│  → loop until completion         │
└────────────────┬─────────────────┘
                 │ LLM requests flow through proxy
                 ▼
┌──────────────────────────────────┐      ┌────────────────────────┐
│  Docker Sandbox (Layer 2)        │      │  Inference Proxy       │
│  pip install numpy ──────────────│─────▶│  (Layer 3) :8199       │
│  → http://pypi.org (via proxy)   │ HTTP │                        │
│  Agent code runs in sandbox      │      │  + policy check        │
│  → http://llm.gateway            │      │  + credential inject   │
│                                  │      │  + audit logging       │
└──────────────────────────────────┘      └──────────┬─────────────┘
                                                     │ forwards
                                          ┌──────────▼─────────────┐
                                          │  LLM Provider          │
                                          │  (OpenAI / Anthropic   │
                                          │   / Local)             │
                                          └────────────────────────┘
```

---

## Process Model

SILO runs as **three separate processes**:

| Process | Lifecycle | Managed By |
|---|---|---|
| **CLI** (`silo` commands) | Short-lived — exits after each command completes | User's terminal |
| **Proxy Daemon** | Long-lived — outlives the CLI process | PID file at `~/.silo/proxy.pid` |
| **Sandbox Container** | Long-lived — runs until `silo stop` | Docker daemon |

The proxy daemon is spawned as a **detached child process** with `child.unref()`, allowing the CLI to exit without killing the proxy. Communication between the CLI and daemon happens through:
- **PID file** — used for liveness checks and signal delivery
- **Health endpoint** — `/_silo/health` for responsiveness verification
- **Config file** — shared state (proxy port, running status)
- **Unix signals** — `SIGHUP` for policy reload, `SIGTERM` for shutdown

---

## Project Structure

```
cli-silo/
├── src/
│   ├── cli.ts                    # Entry point — Commander program
│   ├── commands/
│   │   ├── onboard.ts            # Interactive setup wizard
│   │   ├── quickstart.ts         # Zero-to-sandbox one-command flow
│   │   ├── build.ts              # Docker image builder
│   │   ├── start.ts              # Stack launcher (multi-agent)
│   │   ├── stop.ts               # Stack teardown (--name / --all)
│   │   ├── connect.ts            # Shell into sandbox (--name)
│   │   ├── run.ts                # Agent task runner (LLM loop)
│   │   ├── list.ts               # List running agents
│   │   ├── status.ts             # Health dashboard
│   │   ├── doctor.ts             # System diagnostic checks
│   │   ├── policy.ts             # Policy management subcommands
│   │   ├── integrations.ts       # Integration management (add/list/remove/test)
│   │   ├── logs.ts               # Audit log viewer
│   │   ├── traces.ts             # Framework trace viewer
│   │   ├── frameworks.ts         # Framework list/info subcommands
│   │   └── snapshot.ts           # Container snapshot
│   ├── proxy/
│   │   ├── server.ts             # HTTP proxy + CONNECT tunnel + health
│   │   ├── daemon.ts             # Detached proxy daemon entry point
│   │   ├── provider.ts           # LLM provider routing + auth injection
│   │   ├── interceptor.ts        # TUI approve/deny prompt + policy persistence
│   │   └── spawn.ts              # Shared daemon spawn logic
│   ├── policy/
│   │   ├── engine.ts             # YAML parser + picomatch evaluator + CompiledPolicy
│   │   └── presets.ts            # Built-in preset management
│   ├── audit/
│   │   ├── audit.ts              # JSONL logger + reader + rotation
│   │   ├── tool-calls.ts         # Tool call extraction from LLM responses
│   │   └── traces.ts             # Framework trace event processing
│   ├── docker/
│   │   ├── runner.ts             # Container lifecycle (start/stop/exec)
│   │   └── templates.ts          # Security-hardened docker run flags
│   ├── config/
│   │   ├── schema.ts             # Zod schemas (SiloConfig, LLMConfig)
│   │   ├── manager.ts            # Persistent config read/write/patch (encrypts on write)
│   │   └── encryption.ts         # AES-256-GCM encryption at rest
│   ├── frameworks/
│   │   ├── definitions.ts        # Framework registry definitions
│   │   ├── registry.ts           # Lookup functions (getFramework, listFrameworks)
│   │   ├── docker-builder.ts     # Framework-specific Dockerfile generation
│   │   └── lifecycle.ts          # Framework start/stop hooks
│   ├── integrations/
│   │   ├── templates.ts          # Built-in integration templates
│   │   └── resolver.ts           # Gateway → upstream resolution + auth
│   └── utils/
│       ├── logger.ts             # Branded CLI output (chalk + boxen)
│       ├── health.ts             # Proxy health check + auto-restart
│       ├── pid.ts                # PID file management
│       ├── prompt-listener.ts    # Foreground prompt polling loop and interactive CLI prompts
│       └── system.ts             # System checks (Docker, Node version)
├── policies/
│   ├── default.yaml              # Deny-all baseline
│   ├── pypi.yaml                 # Python package installs
│   └── npm.yaml                  # Node.js package installs
├── sandbox/
│   ├── Dockerfile                # Agent sandbox image
│   ├── entrypoint.sh             # Container PID 1 script
│   └── silo_callbacks/           # Python callback modules for frameworks
├── tests/                        # Vitest test suite
│   ├── audit/
│   │   ├── audit.test.ts         # Audit serialisation + filtering
│   │   ├── tool-calls.test.ts    # Tool call extraction tests
│   │   └── traces.test.ts        # Framework trace tests
│   ├── config/
│   │   ├── encryption.test.ts    # AES-256-GCM encryption round-trips
│   │   └── manager.test.ts       # Config read/write/patch tests
│   ├── docker/
│   │   └── templates.test.ts     # Security hardening flag validation
│   ├── policy/
│   │   ├── engine.test.ts        # Policy evaluation logic
│   │   └── presets.test.ts       # Preset apply/remove
│   ├── proxy/
│   │   ├── provider.test.ts      # Provider routing + auth headers
│   │   └── server.test.ts        # HTTP proxy server tests
│   ├── frameworks/
│   │   ├── registry.test.ts      # Framework registry tests
│   │   └── docker-builder.test.ts # Dockerfile generation tests
│   ├── integrations/
│   │   ├── resolver.test.ts      # Integration resolver + auth injection
│   │   ├── templates.test.ts     # Template registry validation
│   │   └── deep-integration.test.ts  # Schema, Docker flags, edge cases
│   └── commands/onboard.test.ts  # Onboard wizard flow
├── package.json
├── tsconfig.json
├── tsup.config.ts                # Dual-entry build (CLI + daemon)
├── vitest.config.ts
├── install.sh                    # One-line install script
└── uninstall.sh                  # Clean uninstall script
```

---

## Build System

SILO uses **tsup** to bundle two separate entry points:

| Entry | Output | Purpose |
|---|---|---|
| `src/cli.ts` | `dist/cli.js` | CLI binary (has `#!/usr/bin/env node` shebang) |
| `src/proxy/daemon.ts` | `dist/proxy-daemon.js` | Standalone daemon (no shebang, spawned by Node) |

The daemon is built as a separate bundle so `silo start` can spawn it without pulling in the entire CLI dependency graph.

Both outputs target **ESM** format for Node.js 18+.

---

## Dependency Architecture

| Package | Version | Purpose |
|---|---|---|
| `commander` | 12 | Mature CLI framework with subcommand support |
| `inquirer` | 9 (ESM) | Interactive terminal prompts |
| `conf` | 12 | OS-native persistent config (JSON, auto-encryption) |
| `execa` | 8 (ESM) | Safe subprocess execution (no shell injection) |
| `zod` | 3 | Runtime schema validation + TypeScript type inference |
| `yaml` | 2 | Standards-compliant YAML parser/serialiser |
| `picomatch` | 4 | Glob pattern matching for policy host rules |
| `chalk` | 5 | Terminal colours |
| `cli-table3` | 0.6 | Formatted tables for status/logs/list |
| `boxen` | 7 | Branded banner boxes |
| `ora` | 8 | Spinner animations |
| `figures` | 6 | Unicode symbol fallbacks |

---

*SILO v0.2.0 — Secure AI Agent Sandbox Orchestrator*
