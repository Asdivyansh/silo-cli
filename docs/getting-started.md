# Getting Started

> From zero to a running, secured AI agent sandbox in under 5 minutes.

---

## Prerequisites

| Requirement | Minimum Version | How to Check | How to Install |
|---|---|---|---|
| **Node.js** | 18.0.0+ | `node --version` | [nodejs.org](https://nodejs.org) |
| **Docker** | 20.10+ | `docker --version` | [Docker Desktop](https://www.docker.com/products/docker-desktop/) |
| **npm** | 8+ | `npm --version` | Ships with Node.js |
| **LLM API key** | — | — | [OpenAI](https://platform.openai.com), [Anthropic](https://console.anthropic.com), or any local server |

> **Important:** Docker Desktop must be running before using any SILO commands. On Linux, ensure your user is in the `docker` group (`sudo usermod -aG docker $USER`).

---

## Installation

### Option 1: From Source (Recommended)

```bash
# Clone the repository
git clone https://github.com/AsDivyansh/silo.git
cd silo

# Install dependencies
npm install

# Run in development mode (no build step needed)
npm run dev -- --help
```

### Option 2: Build and Install Globally

```bash
# Build the production bundle
npm run build

# Link the binary globally
npm link

# Verify installation
silo --help
```

### Option 3: Install Script

```bash
# From the repository root
./install.sh

# For development mode (symlinks, no build)
./install.sh --dev
```

The install script checks all prerequisites, installs npm dependencies, builds the TypeScript bundle, and creates a global `silo` binary.

### Uninstalling

```bash
./uninstall.sh
```

This will stop any running sandbox, remove installed files, and optionally delete the configuration.

---

## Running Modes

After installation, you can use SILO in two ways:

| Mode | Command | When to Use |
|---|---|---|
| **Development** | `npm run dev -- <command>` | Active development, no build step needed. Uses `tsx` for live TypeScript execution. |
| **Production** | `silo <command>` | After building (`npm run build && npm link`). Faster startup. |

> All examples in this documentation use `silo` for brevity. Replace with `npm run dev --` if you haven't built yet.

---

## Quick Start Walkthrough

### Step 1: Configure Your LLM Provider

```bash
silo onboard
```

The interactive wizard will ask you to:
1. **Choose a provider** — OpenAI, Anthropic, or Local (Ollama, LM Studio, etc.)
2. **Enter your API key** — stored securely on the host, never enters the container
3. **Select a model** — e.g. `gpt-4o`, `claude-sonnet-4-6`, `llama3`
4. **Set a workspace path** — the host directory mounted as `/workspace` inside the sandbox
5. **Configure resource limits** — CPU cores and memory for the container

### Step 2: Build the Sandbox Image

```bash
silo build
```

This builds a Docker image from `sandbox/Dockerfile` containing:
- Python 3.12 runtime
- `curl`, `git`, `jq` utilities
- A non-root user (`agent`, UID 1001)
- Mount points at `/workspace` and `/skills`

### Step 3: Launch the Sandbox

```bash
silo start
```

This creates the full stack:
1. **Docker bridge network** (`silo-sandbox-net`) — internal/no-NAT on native Linux; proxy-routed on Docker Desktop
2. **Inference proxy daemon** — listens on `:8199` on the host
3. **Sandbox container** — hardened, isolated, with all security flags applied

### Step 4: Run an Agent (Two Ways)

**Approach A: Bring Your Own Agent (OpenClaw, AutoGPT, CrewAI)**

This is SILO's primary use case — running a full agent framework *inside* the secure sandbox. The agent works without modification because standard `http_proxy` env vars route all traffic through SILO's proxy.

```bash
# 1. Stop the default sandbox from Step 3 (if running)
silo stop

# 2. Restart with your agent's code mounted
silo start --workspace ~/projects/openclaw

# 3. Allow pip installs (agents usually need dependencies)
silo policy apply pypi

# 4. Open an interactive shell inside the sandbox
silo connect

# 5. Inside the container — install and run your agent
pip install -r requirements.txt

# Point your agent at the proxy (key is injected automatically)
export OPENAI_BASE_URL="http://llm.gateway:8199/v1"
export OPENAI_API_KEY="sk-placeholder"

python3 openclaw.py "refactor the codebase to use async/await"
```

If you want the agent to access local folders outside `/workspace`, mount them explicitly:

```bash
# Desktop appears inside the sandbox as /host/Desktop
silo start --workspace ~/projects/openclaw --desktop

# Or mount a specific folder, optionally read-only
silo start --mount ~/Downloads:/host/Downloads:ro
```

Capability profiles stay explicit:

| Profile | Scope |
|---|---|
| default | Safe coding, text, API, shell, and `/workspace` tasks |
| `--desktop` | Host Desktop at `/host/Desktop` |
| `--mount` | Explicit host folders under `/host/...` |
| `--browser` | Sandboxed Chromium for framework browser automation |

For browser automation, build and start the browser-capable framework image:

```bash
silo build --framework openclaw --browser
silo start --framework openclaw --browser --desktop

# Or prepare browser images for every supported framework
silo build --all-frameworks --browser
```

Browser mode runs Chromium inside the sandbox, not your host Chrome. It keeps `/tmp` hardened, uses disposable browser tmpfs mounts, sets `/dev/shm` to `512m`, and raises container memory to at least `2g` for that run.

**What's happening behind the scenes:**
- Your agent's LLM calls → `http_proxy` → SILO Proxy → credential injection → real LLM API
- API keys **never enter** the container — the proxy injects them at request time
- Every call is policy-checked and audit-logged
- If the agent tries to reach an unauthorized host, you'll see an interactive approve/deny prompt

> **📖 For detailed walkthroughs with OpenClaw, AutoGPT, and CrewAI, see [Running External Agents](./sandbox-agents.md).**
> **📖 For framework-specific integration code, see [Integration Patterns](./integration-patterns.md).**

**Approach B: Use the built-in AI Task Runner (Quick Tasks)**

For simple, one-off tasks you don't need a full agent framework for:

```bash
silo run "Write a Python hello world script and run it"
```

SILO orchestrates the full LLM tool-calling loop:
1. Sends your task to the configured LLM with tool definitions
2. Executes tool calls inside the sandbox via `docker exec`
3. Feeds results back to the LLM
4. Loops until the LLM produces a final response or `--max-turns` is reached

> **📖 For details on the built-in runner, see [Agent Runner](./agent-runner.md).**

### Step 5: Explore and Stop

```bash
# Open an interactive shell inside the sandbox
silo connect

# View the audit trail
silo logs

# See the full status dashboard
silo status

# Shut everything down
silo stop
```

---

## Your First Manual LLM Call (From Inside the Sandbox)

After `silo start`, you can manually test the proxy from inside the container:

```bash
# Open a shell
silo connect

# Make an LLM call — the proxy injects your real API key automatically
curl http://llm.gateway:8199/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Hello from the sandbox!"}]}'

# Check proxy health
curl http://llm.gateway:8199/_silo/health

# Try to reach the internet directly — BLOCKED
curl https://evil.example.com
# → curl: (56) Blocked by SILO policy

# Exit the sandbox (container stays running)
exit
```

---

## Common First-Time Flows

### Allow pip installs for a Python agent

```bash
silo start
silo policy apply pypi
silo run "Install numpy and create a script that generates random data"
```

### Allow npm installs for a Node.js agent

```bash
silo start
silo policy apply npm
silo run "Initialize a new Node.js project and install express"
```

### Run an untrusted agent script safely

```bash
silo start                    # Uses the policy mode chosen during onboard
silo connect
python3 /workspace/untrusted-agent.py
exit
silo logs --verdict deny      # See what it tried to access
silo stop
```

---

## Next Steps

- **[Running External Agents](./sandbox-agents.md)** — Run OpenClaw, AutoGPT, CrewAI, and custom agents
- **[Integration Patterns](./integration-patterns.md)** — Framework-specific code examples
- **[CLI Reference](./cli-reference.md)** — Full command documentation
- **[Policy Engine](./policy-engine.md)** — Write custom egress rules
- **[Security Model](./security-model.md)** — Understand the isolation layers
- **[Agent Runner](./agent-runner.md)** — Advanced agent task orchestration

---

*SILO v0.2.0 — Secure AI Agent Sandbox Orchestrator*
