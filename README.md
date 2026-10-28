<div align="center">

<br />

# SILO

### Run AI Agents You Don't Trust

**Self-hosted CLI for running untrusted AI agents locally inside hardened Docker sandboxes with controlled egress, credential-managed integrations, and transparent inference auditing.**


Built-in agent runner · OpenClaw browser automation · Agent framework support · Policy-governed egress · Transparent inference proxy · Unified audit logging · Framework trace collection · Multi-agent orchestration · Credential-managed integrations

<br />

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](file:///Users/divychaurasia/Desktop/important-stuff/Github-pre-ready/cli-claw-experimentV1.1/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-Required-2496ED?style=flat-square&logo=docker&logoColor=white)](https://www.docker.com/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](file:///Users/divychaurasia/Desktop/important-stuff/Github-pre-ready/cli-claw-experimentV1.1/CONTRIBUTING.md)


[Install](#-install) · [Quick Start](#-quick-start) · [Why SILO?](#-why-silo) · [Capabilities](#-capabilities) · [Frameworks](#-framework-support) · [Examples](#examples) · [Docs](file:///Users/divychaurasia/Desktop/important-stuff/Github-pre-ready/cli-claw-experimentV1.1/docs) · [Contributing](#contributing)

<br />

</div>

---

SILO is a self-hosted developer CLI tool designed to run untrusted AI agents inside hardened Docker sandboxes with controlled egress, credential-managed integrations, and transparent inference auditing. Out of the box, it is built to support advanced agentic workflows including browser automation frameworks such as **OpenClaw**. It relies on several decoupled components:

* **CLI Entrypoint & Commands** ([cli.ts](file:///Users/divychaurasia/Desktop/important-stuff/Github-pre-ready/cli-claw-experimentV1.1/src/cli.ts)): Command orchestration and interactive onboarding wizard ([onboard.ts](file:///Users/divychaurasia/Desktop/important-stuff/Github-pre-ready/cli-claw-experimentV1.1/src/commands/onboard.ts)).
* **Inference & Integration Proxy** ([server.ts](file:///Users/divychaurasia/Desktop/important-stuff/Github-pre-ready/cli-claw-experimentV1.1/src/proxy/server.ts)): Intercepts and logs LLM/egress requests, injects credentials on the host side, and manages the interactive prompter ([interceptor.ts](file:///Users/divychaurasia/Desktop/important-stuff/Github-pre-ready/cli-claw-experimentV1.1/src/proxy/interceptor.ts)).
* **Docker Sandbox Core** ([runner.ts](file:///Users/divychaurasia/Desktop/important-stuff/Github-pre-ready/cli-claw-experimentV1.1/src/docker/runner.ts)): Spawns and manages hardened, capability-restricted Docker containers with resource limits.
* **Policy Engine** ([engine.ts](file:///Users/divychaurasia/Desktop/important-stuff/Github-pre-ready/cli-claw-experimentV1.1/src/policy/engine.ts)): Evaluates egress HTTP requests against declarative YAML policies.
* **Audit Logger** ([audit.ts](file:///Users/divychaurasia/Desktop/important-stuff/Github-pre-ready/cli-claw-experimentV1.1/src/audit/audit.ts)): Standardizes and records all proxy and tool-calling event streams to standard JSONL log files.
* **Config & Encryption Layer** ([manager.ts](file:///Users/divychaurasia/Desktop/important-stuff/Github-pre-ready/cli-claw-experimentV1.1/src/config/manager.ts)): Secures keys at rest using machine-bound PBKDF2 AES-256-GCM encryption ([encryption.ts](file:///Users/divychaurasia/Desktop/important-stuff/Github-pre-ready/cli-claw-experimentV1.1/src/config/encryption.ts)).

---

## 📦 Install

**Requirements:** Node.js 18+, npm, Docker, and an LLM provider key or local OpenAI-compatible endpoint.

```bash
npm install -g cli-silo
silo --help
```

The npm package is named `cli-silo`; the installed command is `silo`.

**From source:**

```bash
git clone https://github.com/AsDivyansh/silo.git
cd silo
npm install
npm run build
npm link
```

Docker Desktop must be running before `silo build`, `silo start`, or `silo quickstart`.

---

## 🚨 Why SILO?

Running AI agents with shell access, file system privileges, and API credentials is **dangerous**. An agent can:

- **Exfiltrate your API keys** by POST-ing them to an external server
- **Execute destructive commands** — `rm -rf /`, credential harvesting, crypto mining
- **Access arbitrary internet hosts** to download malware or exfiltrate data
- **Run unsupervised** with no visibility into what it's doing

**SILO reduces these risks** with a defense-in-depth security architecture:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  HOST MACHINE                                                               │
│                                                                             │
│  ┌──────────────────────┐        ┌─────────────────────────────────────┐   │
│  │   silo CLI            │ start  │   Inference Proxy (:8199)           │   │
│  │   (Node.js)           │───────▶│   • Injects real API key            │   │
│  │                       │        │   • Injects integration tokens       │   │
│  │   $ silo quickstart   │        │   • Evaluates policy per-request     │   │
│  │   $ silo run "task"   │        │   • Records unified audit trail      │   │
│  │   $ silo logs         │        │   • Collects framework traces        │   │
│  │   $ silo logs -F      │        │   • Encrypts API keys at rest        │   │
│  │   $ silo traces       │        │   • Health check + auto-restart      │   │
│  └──────────────────────┘        └──────────┬─────────┬────────────────┘   │
│                                              │         │                    │
│                                   ┌──────────▼──┐  ┌──▼───────────────┐    │
│                                   │ LLM Provider │  │ APIs (Slack,     │    │
│                                   │ OpenAI / etc │  │ GitHub, HubSpot) │    │
│                                   └─────────────┘  └──────────────────┘    │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Docker Sandbox                                                     │   │
│  │  --read-only --cap-drop ALL --user 1001:1001 --pids-limit 128       │   │
│  │  --network silo-sandbox-net (SILO bridge)                           │   │
│  │                                                                     │   │
│  │  Agent ──▶ http://llm.gateway:8199     ──▶ LLM (via proxy)         │   │
│  │  Agent ──▶ http://slack.gateway:8199   ──▶ Slack API (via proxy)   │   │
│  │  Agent ──▶ POST /_silo/traces          ──▶ Unified audit log       │   │
│  │                                                                     │   │
│  │  ✓ HTTP egress routes through the policy proxy                      │   │
│  │  ✗ Cannot see API keys or tokens                                    │   │
│  │  ✗ Cannot escalate privileges                                       │   │
│  │  ✗ Cannot modify the root filesystem                                │   │
│  │  ✓ Can call LLMs through the proxy                                  │   │
│  │  ✓ Can call integrations through gateways                           │   │
│  │  ✓ Can push framework traces to the audit log                       │   │
│  │  ✓ Can read/write /workspace                                        │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

> [!IMPORTANT]
> SILO reduces risk; it does not make arbitrary code safe. Treat sandboxed agents as untrusted, review policy prompts carefully, and only expose host folders with `--desktop` or `--mount` when you are comfortable sharing those files.

---

## ⚡ Quick Start

```bash
# One command does everything — onboard, build, start, connect
silo quickstart

# Or step by step:
silo onboard                  # Interactive setup (provider, API key, security mode)
silo build                    # Build the sandbox Docker image
silo start                    # Launch sandbox + proxy
silo run "List files in /workspace and describe what you find"
silo logs                     # See exactly what the agent did
```

`silo quickstart` asks for your provider, API key, model, workspace, resource limits, and policy mode before launching the first sandbox.

**With a framework:**

```bash
silo quickstart --framework crewai    # Build CrewAI image, start, connect
```

---

## 🧩 Capabilities

### 🤖 Native Agent Runner

Run tasks directly from the CLI. SILO orchestrates the full LLM tool-calling loop — sending prompts, executing tools inside the sandbox, feeding results back, and repeating until done. All LLM calls are routed through the inference proxy for unified audit logging.

```bash
silo run "Create a Python script that calculates fibonacci numbers"
silo run "Install numpy and run the test suite" --max-turns 20
silo run "Refactor the auth module" --name my-agent
```

**Built-in agent tools:**

| Tool | Description |
|---|---|
| `execute_command` | Run any shell command inside the sandbox |
| `read_file` | Read file contents (with optional line limit) |
| `write_file` | Create/overwrite files with arbitrary content |

Supports both **OpenAI** and **Anthropic** function calling formats. All tool execution happens inside the sandboxed container — the agent can never touch the host.

### 🧪 Framework Support

Run popular agent frameworks inside the sandbox with pre-configured Docker images, policy presets, and optional trace collection.

```bash
silo frameworks list                    # See available frameworks
silo build --framework crewai           # Build a CrewAI-ready image
silo start --framework crewai           # Start with CrewAI installed
silo connect                            # Shell in and run your crew
```

**Browser-capable framework image:**

```bash
silo build --framework openclaw --browser
silo start --framework openclaw --browser --desktop

# Or build browser variants for every supported framework
silo build --all-frameworks --browser
```

Browser mode bakes Chromium into a separate framework image, routes common browser executable names through a SILO launcher, keeps `/tmp` mounted `noexec`, and uses disposable tmpfs mounts for browser cache/profile/downloads. At runtime SILO also gives the container a larger `/dev/shm` and raises the memory limit to at least `2g` for browser stability.

The `--browser` profile is available for every supported framework image. OpenClaw is the primary browser-automation use case, but `silo build --all-frameworks --browser` builds browser variants for CrewAI, LangGraph, Aider, SWE-Agent, and OpenClaw.

**Supported frameworks:**

| Framework | Install | TUI | Trace Callbacks |
|-----------|---------|-----|-----------------|
| 🚢 **CrewAI** | `pip` | — | ✅ `SiloCrewCallbacks` (event listener) |
| 🔀 **LangGraph** | `pip` | — | ✅ `SiloLangChainCallbacks` (BaseCallbackHandler) |
| 🧑‍💻 **Aider** | `pip` | ✅ `silo connect --tui` | — |
| 🔧 **SWE-Agent** | `pip` | — | — |
| 🦞 **OpenClaw** | `npm` | ✅ `silo connect --tui` | — |

#### 🤖 Bring Your Own Agent

Any agent not listed above can be added without forking SILO. Drop a YAML definition into `~/.silo/frameworks/` and it behaves like a built-in — `silo build --framework my-agent`, `silo start --framework my-agent`, policies, audit logging, and (optionally) `silo connect --tui` all work identically:

```yaml
# ~/.silo/frameworks/my-agent.yaml
id: my-agent
name: My Agent
description: My experimental autonomous agent
install:
  method: pip            # pip | npm | custom (raw Dockerfile snippet)
  packages: ["my-agent-pkg"]
healthCheck: my-agent --version
tuiCommand: my-agent     # optional
requiredPolicies: ["pypi"]
envVars:                 # route its LLM calls through the SILO proxy
  OPENAI_API_BASE: "http://llm.gateway:8199/v1"
  OPENAI_API_KEY: "silo-proxy-injected"
tmpfsMounts: ["/home/agent"]   # writable home on the read-only rootfs
```

A custom definition with the same `id` as a built-in overrides it, so you can also tweak how SILO runs the bundled frameworks.

#### 🦞 OpenClaw Support
OpenClaw is the primary target for browser automation within SILO. When you build and run OpenClaw with the `--browser` profile, SILO automatically starts a background OpenClaw Gateway daemon inside the container. This gateway coordinates headless Chromium sessions and forces all outbound LLM calls to route securely through the host-side SILO inference proxy.

Each framework image layers on top of the base sandbox — security hardening, policy engine, and audit logging all work identically.

> [!TIP]
> **Memory Allocation for Browser & GUI-Based Agents:**
> SILO keeps the default `512m` limit for text-based frameworks. When you start with `--browser`, SILO uses at least `2g` of container memory and a `512m` shared-memory segment so headless Chromium does not randomly die from Docker OOM or `/dev/shm` pressure.

### 📊 Unified Audit Log

Every event flows into a single `~/.silo/audit.jsonl` timeline — LLM calls, tool invocations, egress requests, blocked attempts, and framework traces. One file, one command, fully queryable.

```bash
$ silo logs

┌──────────┬──────────┬────────┬───────────┬────────────────────────────┬────────┬─────────┬─────────────┐
│ Time     │ Category │ Verdict│ Method    │ Host                       │ Status │ Latency │ Detail      │
├──────────┼──────────┼────────┼───────────┼────────────────────────────┼────────┼─────────┼─────────────┤
│ 18:30:12 │ llm      │ allow  │ POST      │ llm.gateway                │ 200    │ 1423ms  │ crewai      │
│ 18:30:14 │ tool_call│ allow  │ TOOL_CALL │ llm.gateway                │ 200    │ 0ms     │ read_file   │
│ 18:30:15 │ trace    │ allow  │ TRACE     │ framework                  │ 0      │ 0ms     │ agent_start │
│ 18:31:02 │ egress   │ allow  │ GET       │ pypi.org                   │ 200    │ 156ms   │ —           │
│ 18:32:10 │ blocked  │ deny   │ POST      │ evil.example.com           │ 403    │ 2ms     │ —           │
└──────────┴──────────┴────────┴───────────┴────────────────────────────┴────────┴─────────┴─────────────┘
```

**Filter everything:**

```bash
silo logs --category llm                 # Just LLM calls
silo logs --category trace               # Framework lifecycle events
silo logs --framework crewai             # All CrewAI activity
silo logs --agent Researcher             # Just one agent
silo logs --verdict deny --since 1h      # Blocked requests in the last hour
silo logs --follow                       # Live tail (like tail -f)
silo logs --follow --verdict deny        # Live tail only blocked requests
silo logs --json | jq '.host' | sort -u  # All unique hosts accessed
silo traces                              # Shortcut for trace view
```

### 👥 Multi-Agent Support

Run multiple isolated agents simultaneously, each with its own container, workspace, and resource limits — sharing a single proxy daemon.

```bash
silo start --name alpha --workspace ~/project-a
silo start --name beta --workspace ~/project-b
silo list                         # See all running agents
silo connect --name alpha         # Shell into a specific agent
silo run "Run tests" --name beta  # Run a task on a specific agent
silo stop --all                   # Stop everything
```

### 🔒 Hardened Docker Sandbox

Every agent runs as a non-root user inside a read-only container with all Linux capabilities dropped. On every platform, SILO uses an internal Docker bridge with no NAT gateway, so sandboxes have no direct internet route. On native Linux the proxy is reached via `host-gateway`; on Docker Desktop for macOS/Windows, a hardened `socat` sidecar (`silo-gateway`) relays the proxy port across the VM boundary — the policy proxy remains the only egress path.

```
--user 1001:1001                  Non-root execution
--read-only                       Immutable root filesystem
--cap-drop ALL                    All capabilities removed
--security-opt no-new-privileges  No setuid/setgid escalation
--pids-limit 128                  Fork-bomb protection
--tmpfs /tmp:noexec,nosuid        Ephemeral scratch only
--network silo-sandbox-net        SILO bridge network
```

**Capability profiles:**

| Profile | Command Flag | Resources & Mounts | Security Implications |
|---|---|---|---|
| **default** | *None (Default)* | Isolated `/workspace` only; `512m` memory limit | Safe coding, text, API, shell execution |
| **Desktop** | `--desktop` | Read-write host Desktop mounted as `/host/Desktop` | Agent can read/write host Desktop files |
| **Custom Mounts** | `--mount <host>:<guest>:<mode>` | Map specific host directories to `/host/...` | Selectively exposes specific folders (e.g. read-only) |
| **Browser Mode** | `--browser` | Sandboxed Chromium; `/tmp` `noexec`; raises memory to `2g` & `/dev/shm` to `512m` | Enables browser automation (e.g., OpenClaw) without host compromise |

Detailed design guidelines on these profiles can be found in the [Capability Profiles Guide](file:///Users/divychaurasia/Desktop/important-stuff/Github-pre-ready/cli-claw-experimentV1.1/docs/capability-profiles.md).

**Opt-in local filesystem access:**

```bash
# Let the agent create/read files on your Desktop
silo start --framework openclaw --desktop

# Mount any host path under /host in the sandbox (read-only for extra safety)
silo start --mount ~/Downloads:/host/Downloads:ro
```

Agents can always read and write to `/workspace`. Host paths like Desktop, Downloads, or Documents are completely invisible to the sandboxed agent unless explicitly exposed.

### 🔌 Local Development & Port Forwarding

AI agents often need to interact with local development services (like a database, backend API, or local dev server) running directly on your host machine. Since the agent executes inside an isolated Docker sandbox, `localhost` or `127.0.0.1` inside the container refers to the container itself, not your host.

To allow the agent to reach services running on your host machine:

1. **Access via host gateway**: Use `host.docker.internal` instead of `localhost` in your commands or configs. For example, to query a host API on port `3000`, the agent should connect to `http://host.docker.internal:3000`.
2. **Authorize Egress**: In Strict policy mode, the proxy will intercept this egress attempt. You will be prompted in the interactive TUI to allow the connection, or you can add it permanently to your active policy file:
   ```yaml
   # Add to your policy file
   rules:
     - host: "host.docker.internal"
       action: allow
       comment: "Local Host Development Server"
   ```

### 🌐 Transparent Inference Proxy

A host-side HTTP proxy sits between the agent and the outside world. The agent makes plain HTTP calls to `http://llm.gateway:8199` — the proxy intercepts, injects the real API key, and forwards to the actual LLM provider. The agent never sees the key.

```bash
# Inside the sandbox — the agent doesn't need any credentials:
curl http://llm.gateway:8199/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Hello"}]}'
```

### 📋 YAML Policy Engine

Declarative egress control. Define which hosts the agent can reach with a simple YAML file. During `silo onboard`, you choose between **Strict** (deny by default) and **Audit Only** (allow by default). Both modes log every request.

```yaml
# Strict mode (chosen during onboard) — safest, blocks unknown traffic
version: "1"
name: "strict"
default: deny
rules:
  - host: "llm.gateway"
    action: allow
    comment: "LLM inference proxy"
  - host: "pypi.org"
    action: allow
  - host: "files.pythonhosted.org"
    action: allow
```

```yaml
# Audit-only mode (chosen during onboard) — least friction, full visibility
version: "1"
name: "audit-only"
default: allow
rules:
  - host: "llm.gateway"
    action: allow
```

Built-in presets and one-liner management:

```bash
silo policy apply pypi                     # Allow pip installs
silo policy apply npm                      # Allow npm/yarn installs
silo policy add api.github.com             # One-liner: add a single host
silo policy reload                         # Hot-reload without restart
```

### 🛡️ Interactive TUI Interceptor

When the agent tries to reach a host not in the policy, the proxy prompts you in real-time:

```
⚠  Sandbox is requesting access to an unauthorised host
  Method : POST
  Host   : suspicious-api.example.com
  URL    : http://suspicious-api.example.com/webhook

? How should this request be handled?
  ❯ Allow once   (this request only)
    Allow always (add to active policy)
    Deny         (block this request)
```

In headless/CI mode, unauthorised requests are auto-denied and logged.

### 🔌 Credential-Managed Integrations

Connect agents to productivity APIs — Slack, GitHub, HubSpot, and more — without exposing credentials.

```bash
silo integrations add slack              # Stores token host-side
silo integrations add github             # Same pattern

# Inside the sandbox — no credentials needed:
curl http://slack.gateway:8199/chat.postMessage \
  -H "Content-Type: application/json" \
  -d '{"channel":"#general","text":"Hello from SILO agent!"}'
```

Built-in templates for **Slack**, **GitHub**, **HubSpot**, **Linear**, and **Notion**. See [integrations.md](file:///Users/divychaurasia/Desktop/important-stuff/Github-pre-ready/cli-claw-experimentV1.1/docs/integrations.md) for the full guide.

Integration gateways keep working in `--browser` mode. The browser profile only changes the framework container image and runtime browser mounts; `slack.gateway`, `github.gateway`, and other credential-managed aliases are still routed through the host proxy with credentials injected outside the sandbox.

### 📸 Snapshots

Save and restore container state:

```bash
silo snapshot create "clean-install"     # Save current state
silo snapshot list                       # View snapshots
silo snapshot rollback "clean-install"   # Restore
silo snapshot delete "clean-install"     # Clean up
```

### 🩺 System Diagnostics

```bash
silo doctor                              # Check Docker, Node, config, proxy health
silo status                              # Full dashboard: container, proxy, audit stats
```

---

## Examples

### Example 1: Quick Agent Task

```bash
silo quickstart
silo run "Write a Python script that fetches the top 10 HN stories and saves them as CSV"
silo logs
silo stop
```

### Example 2: CrewAI Multi-Agent Research

```bash
# Setup
silo build --framework crewai
silo start --framework crewai
silo connect

# Inside the container:
python3 << 'EOF'
from crewai import Agent, Task, Crew

researcher = Agent(role="Researcher", goal="Find key facts", backstory="Expert researcher.", verbose=True)
writer = Agent(role="Writer", goal="Write a summary", backstory="Skilled writer.", verbose=True)

research = Task(description="Research Docker container security. List 5 key points.", expected_output="5 bullet points.", agent=researcher)
summary = Task(description="Write a 2-paragraph summary from the research.", expected_output="2 paragraphs.", agent=writer)

crew = Crew(agents=[researcher, writer], tasks=[research, summary], verbose=True)
print(crew.kickoff())
EOF

# Back on host — see everything that happened:
exit
silo logs --framework crewai
silo stop
```

### Example 3: Agentic Workflow with GitHub + Slack

```bash
silo onboard
silo build
silo integrations add github
silo integrations add slack
silo start
silo policy apply github
silo policy add slack.com

silo run "Fetch open issues from the GitHub repo, label bugs as priority, \
  generate a triage report in /workspace, and post a summary to #engineering on Slack"

# Inspect: 4 LLM turns, 2 GitHub calls, 1 Slack post — zero credentials exposed
silo logs
silo stop
```

### Example 4: Untrusted Agent Audit

```bash
silo start                               # Uses the policy mode chosen during onboard

silo connect
python3 /workspace/third-party-agent.py  # Run the untrusted code
exit

silo logs --verdict deny                 # See what was blocked
# Output:
#   evil-c2-server.io        → deny
#   pastebin.com             → deny
#   webhook.site             → deny

silo stop
```

### Example 5: Browser Automation with OpenClaw

Set up OpenClaw with browser automation and local Desktop access to have the agent work with your local files and browse websites safely.

```bash
# 1. Build the browser-capable OpenClaw image
silo build --framework openclaw --browser

# 2. Start the container with browser support and mount your Desktop
silo start --framework openclaw --browser --desktop

# 3. Connect to the container's shell
silo connect

# 4. Inside the container, run an OpenClaw task to browse a site and save results to your host Desktop
openclaw run "Search for 'Docker container security presets', take a screenshot of the top result, and save it to /host/Desktop/screenshot.png"

# 5. Exit the container
exit

# 6. Verify what connections the agent made or attempted
silo logs
silo stop
```

> Full command reference: [cli-reference.md](file:///Users/divychaurasia/Desktop/important-stuff/Github-pre-ready/cli-claw-experimentV1.1/docs/cli-reference.md)

---

## 🛡️ Security Model

SILO implements **defence in depth** across multiple layers:

| Layer | What It Does | How |
|---|---|---|
| **Container hardening** | Prevents privilege escalation and system damage | Non-root user, read-only fs, no capabilities, PID limits |
| **Network isolation** | Restricts egress paths | Native Linux no-NAT bridge; Docker Desktop proxy-routed egress with source allowlist |
| **Policy engine** | Controls which hosts the agent can reach | YAML rules evaluated per-request; deny by default |
| **Credential isolation** | Keeps API keys away from the agent | Keys stored host-side; proxy injects at request time |
| **Audit trail** | Full visibility into agent behaviour | Unified JSONL log with LLM, tool, egress, trace events |

**Additional protections:**

- **API keys encrypted at rest** using AES-256-GCM with a machine-bound key (PBKDF2)
- Auth headers from the container are **stripped** before forwarding (prevents key forgery)
- HTTPS CONNECT to `llm.gateway` is **rejected** (forces plain HTTP so the proxy can inspect)
- `silo run` LLM calls are **routed through the proxy** for unified audit logging
- "Allow always" interceptor decisions are **persisted** to the policy file automatically
- Session-based audit trail with unique session IDs for forensic correlation
- Automatic log rotation (10MB default, 5 rotated files)
- Proxy health check (`/_silo/health`) with auto-restart on crash

> Project structure and architecture: [architecture.md](file:///Users/divychaurasia/Desktop/important-stuff/Github-pre-ready/cli-claw-experimentV1.1/docs/architecture.md)

---

## 🛠️ Development

```bash
npm install                       # Install dependencies
npm run dev -- <command>          # Run in dev mode (tsx, no build step)
npm test                          # Run test suite
npm run typecheck                 # TypeScript type checking
npm run build                     # Bundle to dist/

SILO_DEBUG=1 npm run dev -- start # Verbose debug logging
```

**Project structure:**

```
src/
  cli.ts                          # Command definitions
  commands/                       # Command implementations
  proxy/                          # Inference proxy (server, daemon, interceptor, spawner)
  policy/                         # YAML policy engine + presets
  audit/                          # Audit log, tool call extraction, trace collector
  frameworks/                     # Framework registry, definitions, Docker builder
  integrations/                   # Credential-managed API integrations
  config/                         # Config schema, manager, AES-256 encryption
  docker/                         # Docker container management (templates + runner)
  utils/                          # Logger, system checks, health, PID management
sandbox/                          # Dockerfile, entrypoint, Python callbacks
tests/                            # Vitest test suite
policies/                         # Example policy YAML files
docs/                             # [Full documentation](file:///Users/divychaurasia/Desktop/important-stuff/Github-pre-ready/cli-claw-experimentV1.1/docs)
```

---

## Contributing

Contributions are welcome! Whether it's a bug fix, new feature, documentation improvement, or just a typo — we appreciate it all.

For vulnerability reports, please follow [SECURITY.md](file:///Users/divychaurasia/Desktop/important-stuff/Github-pre-ready/cli-claw-experimentV1.1/SECURITY.md) instead of opening a public issue.

1. **Fork** the repo
2. **Create** a feature branch (`git checkout -b feat/amazing-feature`)
3. **Commit** your changes (`git commit -m 'feat: add amazing feature'`)
4. **Push** to the branch (`git push origin feat/amazing-feature`)
5. **Open** a Pull Request

> **First time contributing?** Look for issues labeled [`good first issue`](https://github.com/AsDivyansh/silo/labels/good%20first%20issue).

---

## License

MIT © [Divyansh Chaurasia](https://github.com/AsDivyansh)

---

<div align="center">

**If SILO helps you ship agents safely, consider giving it a ⭐**

<br />

[⬆ Back to Top](#silo)

</div>
