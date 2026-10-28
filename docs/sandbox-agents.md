# Running External Agents in SILO

> The complete guide to running OpenClaw, AutoGPT, CrewAI, and any custom agent framework inside a security-governed sandbox — with zero modification to the agent code.

---

## Why Sandbox Your Agent?

When you run an AI agent on your bare machine, you're giving it:

| Risk | What Happens Without SILO |
|---|---|
| **Full filesystem access** | Agent can read `~/.ssh`, `~/.aws`, browser cookies, anything on disk |
| **API keys in environment** | `$OPENAI_API_KEY` is readable by any process — agent can exfiltrate it |
| **Unrestricted networking** | Agent can POST your credentials, source code, or secrets to any server |
| **Root or user-level privileges** | Nothing stops `rm -rf`, installing malware, or crypto miners |
| **No audit trail** | You have zero visibility into what the agent actually did |

SILO puts an **entire security platform** between your OS and the agent. The agent runs in a hardened Docker container with no API keys, policy-governed egress, and every action logged — while still being fully functional.

---

## How It Works: Zero Agent Modification

The key insight: **your agent doesn't know it's sandboxed.** SILO uses standard mechanisms that every HTTP client already respects.

```
┌─────────────────────────────────────────────────────────────────────┐
│  YOUR AGENT (inside sandbox container)                              │
│                                                                     │
│  import openai                                                      │
│  client = openai.OpenAI(base_url="http://llm.gateway:8199/v1")     │
│  # OR: the http_proxy env var routes it automatically               │
│  # The agent thinks it's talking to OpenAI directly                 │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               │  HTTP request (no API key attached)
                               │
┌──────────────────────────────▼──────────────────────────────────────┐
│  SILO PROXY (host-side, port 8199)                                  │
│                                                                     │
│  1. Policy check    → Is this destination allowed?                  │
│  2. Key injection   → Attach real API key from host-side config     │
│  3. Audit logging   → Record request, response, tokens, latency    │
│  4. Forward upstream → Send to api.openai.com / api.anthropic.com   │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               │  Authenticated HTTPS request
                               ▼
                     ┌──────────────────┐
                     │  LLM Provider    │
                     │  (OpenAI, etc.)  │
                     └──────────────────┘
```

### Three Mechanisms That Make This Seamless

1. **`http_proxy` / `https_proxy` environment variables** — Set automatically inside the container. Standard HTTP clients (`curl`, Python `requests`, `httpx`, `pip`, `npm`) all respect these and route traffic through the proxy without any code changes.

2. **`llm.gateway` DNS alias** — Docker's `--add-host` injects this hostname into the container's `/etc/hosts`, resolving to the host machine's IP. Agents can target `http://llm.gateway:8199/v1/...` as their LLM endpoint.

3. **SILO Docker bridge** — The container runs on `silo-sandbox-net`. On native Linux this network is created with `--internal` for no-NAT isolation; on Docker Desktop for macOS/Windows it uses proxy-routed HTTP clients plus a Docker-network source allowlist on the host proxy.

---

## Running OpenClaw in SILO

[OpenClaw](https://github.com/openclaw) is a powerful autonomous agent framework. Here's how to run it fully sandboxed:

### Step 1: Set Up SILO

```bash
# Configure your LLM provider (API key stays on the host)
silo onboard

# Build the sandbox image
silo build
```

### Step 2: Start the Sandbox with OpenClaw's Code

```bash
# Mount the OpenClaw repository as the workspace
silo start --workspace ~/projects/openclaw
```

### Step 3: Configure Network Policy

OpenClaw needs access to the LLM (always allowed) and may need PyPI for dependencies:

```bash
# Allow pip installs
silo policy apply pypi

# If OpenClaw needs GitHub access (for cloning repos, etc.)
silo policy add "api.github.com" --comment "GitHub API for OpenClaw"
silo policy add "github.com" --comment "GitHub for git operations"
silo policy add "*.githubusercontent.com" --comment "GitHub raw content"
```

### Step 4: Enter the Sandbox and Run OpenClaw

```bash
# Open an interactive shell inside the sandbox
silo connect

# Inside the container — install OpenClaw dependencies
pip install -r requirements.txt

# Run OpenClaw! It automatically uses the proxy for LLM calls.
# No API key needed — the proxy injects it.
python3 openclaw.py "refactor the codebase to use async/await"
```

> **What's happening behind the scenes:**
> - OpenClaw's LLM calls go through `http_proxy` → SILO Proxy → real API (with key injected)
> - OpenClaw cannot access any host not in the policy (no data exfiltration)
> - Every LLM request is logged with timestamps, tokens, and latency
> - OpenClaw runs as UID 1001 with a read-only root filesystem
> - If OpenClaw tries to reach an unauthorized host, you'll see an interactive prompt

### Step 5: Monitor and Review

```bash
# In another terminal — watch what OpenClaw is doing
silo status

# View the audit trail of all LLM calls
silo logs --category llm

# See what was blocked
silo logs --verdict deny

# View everything
silo logs
```

---

## Other Agent Frameworks

The same pattern works for **any** HTTP-based agent. The steps are always:

1. `silo start --workspace ~/projects/<agent>` — mount the agent's code
2. `silo policy apply pypi` (and/or `npm`) — allow package installs
3. `silo policy add <hosts>` — allow any additional domains the agent needs
4. `silo connect` → install deps → set `OPENAI_BASE_URL=http://llm.gateway:8199/v1` → run the agent
5. `silo logs` — review what happened

| Framework | Key Setup Detail |
|---|---|
| **AutoGPT** | Set `OPENAI_API_BASE=http://llm.gateway:8199/v1`. Needs web browsing — add domains via `silo policy add` or use the interactive interceptor to discover what it needs. |
| **CrewAI** | Set `OPENAI_BASE_URL=http://llm.gateway:8199/v1`. Multi-agent orchestration works transparently — all agents' LLM calls are audited. |
| **LangGraph** | Set `OPENAI_API_BASE=http://llm.gateway:8199/v1`. Tools execute inside the sandbox. |
| **Custom agents** | If your agent uses `requests`, `httpx`, `curl`, or any standard HTTP client, it routes through the proxy automatically via `http_proxy` env vars. |

> **📖 For detailed framework-specific code, see [Integration Patterns](./integration-patterns.md).**

---

## Registering a Custom Framework

If you run the same agent regularly, promote it from the manual workflow above to a first-class framework. SILO loads user-provided definitions from `~/.silo/frameworks/*.yaml` (or `.json`) at startup; each one gets its own Docker image, auto-applied policies, health check, and optional TUI — identical to the built-ins.

```yaml
# ~/.silo/frameworks/my-agent.yaml
id: my-agent                  # lowercase, used in CLI flags and the image tag
name: My Agent
description: My experimental autonomous agent
install:
  method: pip                 # pip | npm | custom
  packages: ["my-agent-pkg"]
  # systemDeps: ["build-essential"]      # extra apt packages
  # dockerSnippet: |                     # raw Dockerfile lines (method: custom)
  #   RUN ...
healthCheck: my-agent --version
tuiCommand: my-agent          # optional — enables `silo connect --tui`
requiredPolicies: ["pypi"]    # policy presets auto-applied on `silo start`
envVars:
  OPENAI_API_BASE: "http://llm.gateway:8199/v1"
  OPENAI_API_KEY: "silo-proxy-injected"   # placeholder; real key injected host-side
tmpfsMounts: ["/home/agent"]  # writable home on the read-only rootfs
tmpfsMountSizes:
  /home/agent: "128m"
```

Then:

```bash
silo build --framework my-agent
silo start --framework my-agent
silo connect --tui        # if tuiCommand is set
```

Notes:

- `silo frameworks` lists custom definitions alongside the built-ins.
- A custom file with the same `id` as a built-in **overrides** it (a warning is printed) — useful for tweaking e.g. OpenClaw's defaults.
- Invalid files are skipped with a warning; they never break the CLI.
- The two `envVars` shown are the key trick: they point the agent's OpenAI-compatible client at the SILO proxy, which injects your real credentials host-side so the sandbox never sees them.

---

## Running Untrusted or Unknown Agents

This is where SILO shines brightest — when you want to run an agent you don't fully trust.

### The "Observe First" Workflow

```bash
# 1. Start with Strict mode (chosen during silo onboard)
silo start --workspace ~/projects/untrusted-agent

# 2. Enter and run the agent
silo connect
python3 /workspace/agent.py "do something"
exit

# 3. See everything it tried to access
silo logs --verdict deny

# Output:
# 2026-04-12T18:00:01Z  DENY  POST  suspicious-api.example.com  /webhook
# 2026-04-12T18:00:02Z  DENY  GET   cdn.malware.example.com     /loader.js
# 2026-04-12T18:00:03Z  DENY  POST  api.openai.com              /v1/chat/completions
```

### The "Interactive Interceptor" Workflow

When you run SILO with a TTY (not in daemon mode), the proxy prompts you in real-time whenever the agent tries to reach an unauthorized host:

```
⚠  Sandbox is requesting access to an unauthorised host
  Method : POST
  Host   : api.github.com
  URL    : https://api.github.com/repos/user/project/contents

? How should this request be handled?
  ❯ Allow once   (this request only)
    Allow always (add to active policy)
    Deny         (block this request)
```

- **Allow once** — let this specific request through; future requests to the same host will prompt again
- **Allow always** — permanently add this host to the active policy file
- **Deny** — block the request, return HTTP 403

This lets you build a precise policy by watching what the agent actually needs, rather than guessing upfront.

---

## The Skills System

SILO supports a **skills** mechanism that lets you pre-configure the sandbox environment for specific agent frameworks.

### How It Works

The sandbox entrypoint (`entrypoint.sh`) automatically sources every `*.sh` file in `/skills` on container startup. This lets you pre-configure environment variables, install tools, or set up agent-specific configuration.

### Example Skill

```bash
# skills/openclaw-setup.sh
#!/bin/sh
export OPENAI_BASE_URL="http://llm.gateway:8199/v1"
export OPENAI_API_KEY="sk-placeholder"  # Proxy injects the real key
export PYTHONPATH="/workspace:${PYTHONPATH}"
```

Skill scripts run as the `agent` user (UID 1001). The `/skills` mount point exists in the sandbox Dockerfile — mount your scripts directory when starting the container.

---

## Custom Sandbox Images

The default sandbox image includes Python 3.12, curl, git, and jq. For agents that need different runtimes, customize the Dockerfile. The key requirements are:

- Non-root user with **UID/GID 1001** (SILO's hardening flags expect this)
- `/workspace` and `/skills` directories owned by that user
- Copy `entrypoint.sh` and set it as the entrypoint
- `CMD ["tail", "-f", "/dev/null"]` to keep the container alive for `docker exec`

### Example: Node.js Agent Sandbox

```dockerfile
# sandbox/Dockerfile.node
FROM node:20-slim
RUN groupadd --gid 1001 agent && \
    useradd --uid 1001 --gid 1001 --no-create-home --shell /bin/sh agent
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl git ca-certificates jq python3 && rm -rf /var/lib/apt/lists/*
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
RUN mkdir -p /workspace /skills && chown 1001:1001 /workspace /skills
USER agent
WORKDIR /workspace
ENTRYPOINT ["/entrypoint.sh"]
CMD ["tail", "-f", "/dev/null"]
```

Build with `docker build -f sandbox/Dockerfile.node -t silo-sandbox:node ./sandbox`, then set the image tag in your SILO config.

---

## What Your Agent Can and Cannot Do

### ✅ Your Agent Can

- Read and write files in `/workspace` (your mounted project)
- Read and write opt-in host mounts under `/host` when started with `--desktop` or `--mount`
- Write temporary files to `/tmp` (up to 64MB, no executables)
- Run Python scripts, install pip packages (if policy allows PyPI)
- Call any LLM through the proxy at `http://llm.gateway:8199`
- Use git, curl, jq, and standard Unix utilities
- Run multiple processes (up to 128 PIDs)
- Access policy-approved websites (PyPI, GitHub, npm, etc.)

### ❌ Your Agent Cannot

- Access API keys (they never enter the container)
- Access your Desktop, Downloads, Documents, or other host folders unless you explicitly mount them
- Reach hosts blocked by the active policy through standard HTTP clients
- Reach hosts not in the policy (blocked with HTTP 403)
- Escalate to root (UID 1001, no capabilities, no-new-privileges)
- Modify the OS or install system packages (read-only root filesystem)
- Execute binaries written to `/tmp` (noexec mount flag)
- Fork bomb the host (128 PID limit)
- Exhaust CPU or memory (configurable resource throttles)

---

## Opt-In Local Filesystem Access

By default, SILO only exposes the configured workspace as `/workspace`. If an agent asks to create a file on "my Desktop", it will not see your host Desktop unless you opt in:

```bash
silo start --framework openclaw --desktop
```

Inside the sandbox, your Desktop is then available at:

```bash
/host/Desktop
```

For example, ask OpenClaw to create `/host/Desktop/greatness.md`, not `~/Desktop/greatness.md`. For other local folders:

```bash
silo start --mount ~/Downloads:/host/Downloads:ro
silo start --mount ~/Documents/safe-agent-folder:/host/Documents:rw
```

Additional host mounts must target `/host/...` so they cannot accidentally replace container system paths.

---

## Capability Profiles

SILO keeps capabilities additive and explicit:

| Profile | Scope |
|---|---|
| default | Safe coding, text, API, shell, and `/workspace` tasks |
| `--desktop` | Adds host Desktop at `/host/Desktop` |
| `--mount` | Adds explicit host folders under `/host/...` |
| `--browser` | Adds sandboxed Chromium for framework browser automation |

These profiles compose. For example, `silo start --framework openclaw --browser --desktop` gives OpenClaw the sandbox browser plus explicit Desktop access, while still keeping your host Chrome profile, cookies, and password manager out of the container.

---

## Browser Automation Mode

Framework browser mode gives agents a sandboxed Chromium runtime without giving them your host browser profile, cookies, password manager, or desktop session.

```bash
silo build --framework openclaw --browser
silo start --framework openclaw --browser --desktop

# Or prepare browser-capable images for every supported framework
silo build --all-frameworks --browser
```

Inside the browser-capable image:

- Chromium is baked into the read-only image layer.
- Common browser names (`chrome`, `google-chrome`, `chromium`, `chromium-browser`) resolve to SILO's Chromium launcher.
- `/tmp` remains mounted with `noexec,nosuid`.
- Browser cache, profile, and downloads use disposable tmpfs mounts.
- `/dev/shm` is increased to `512m` for Chromium stability.
- Container memory is raised to at least `2g` for browser runs.
- Browser launch args include `--no-sandbox`, `--disable-setuid-sandbox`, and `--disable-dev-shm-usage`.

Useful environment variables inside the sandbox:

```bash
CHROME_BIN=/usr/local/bin/silo-chromium
PUPPETEER_EXECUTABLE_PATH=/usr/local/bin/silo-chromium
SILO_BROWSER_PROFILE_DIR=/browser-profile
SILO_BROWSER_DOWNLOADS_DIR=/browser-downloads
SILO_BROWSER_ARGS="--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage --user-data-dir=/browser-profile"
```

Ask OpenClaw to use the sandbox browser. For local files, combine browser mode with `--desktop` and use `/host/Desktop/...`.

Credential-managed integrations keep the same behavior in browser mode. Gateway aliases such as `slack.gateway` and `github.gateway` are still registered as Docker host aliases and still route through the host proxy, so credentials remain outside the sandbox.

---

## SILO vs. Running Agents Directly

| | Running on Bare OS | Running in SILO |
|---|---|---|
| **API key exposure** | Agent reads `$OPENAI_API_KEY` directly | Key never enters container; proxy injects at request time |
| **Network access** | Unrestricted — agent can POST data anywhere | Only policy-approved hosts; Strict (deny) or Audit Only (allow) mode |
| **Filesystem scope** | Full home directory, SSH keys, browser data | Only `/workspace` and ephemeral `/tmp` |
| **Privilege level** | Your user account (possibly root) | Non-root UID 1001, zero Linux capabilities |
| **Audit trail** | None — you hope the agent logs something | Every HTTP request logged with timing, tokens, verdict |
| **Live monitoring** | `top` and hope | `silo status`, `silo logs`, interactive intercept prompts |
| **Resource limits** | Agent can consume all CPU/RAM | Configurable CPU, memory, and PID limits |
| **Cleanup** | Hope the agent didn't leave breadcrumbs | `silo stop` removes the container completely |

## SILO vs. NemoClaw

| Feature | NemoClaw | SILO |
|---|---|---|
| **Container hardening** | Basic Docker isolation | Read-only FS, cap-drop ALL, no-new-privileges, PID limits, noexec /tmp, non-root, SILO network, resource throttles |
| **Network model** | Container has internet access | Native Linux no-NAT bridge; Docker Desktop proxy-routed egress with host-proxy source allowlist |
| **Egress policy** | No policy engine | Declarative YAML policy, glob patterns, deny-by-default, hot-reload |
| **API key protection** | Keys passed into container via env vars | Keys **never enter** the container — injected at proxy level |
| **Interactive interception** | Not available | Real-time approve/deny prompts for unauthorized requests |
| **Multi-agent support** | Single container | Named concurrent agents with isolated workspaces |
| **Audit trail** | Basic logging | JSONL audit with method, host, verdict, latency, model, tokens + rotation |
| **Agent runner** | Built-in only | Built-in `silo run` **plus** BYO agent support (OpenClaw, AutoGPT, etc.) |
| **Policy presets** | None | Built-in presets for PyPI, npm; one-liner `silo policy add` |
| **Proxy health** | Manual restart | Auto-detect crashes and restart transparently |

---

## Troubleshooting External Agents

| Problem | Solution |
|---|---|
| **Agent can't reach the LLM** | Test with `curl http://llm.gateway:8199/_silo/health` inside the container. If it fails, run `silo status` from the host — the proxy may need a restart. |
| **"Blocked by SILO policy"** | Run `silo logs --verdict deny` to see what's blocked, then `silo policy add "the-host.com"` to allow it. |
| **pip/npm install fails** | Package registries need whitelisting: `silo policy apply pypi` or `silo policy apply npm`. |
| **Agent needs API key env vars** | Set placeholders — the proxy replaces them: `export OPENAI_API_KEY="sk-placeholder"` and `OPENAI_BASE_URL="http://llm.gateway:8199/v1"`. For Anthropic: `ANTHROPIC_API_KEY="sk-ant-placeholder"` and `ANTHROPIC_BASE_URL="http://llm.gateway:8199"`. |

---

*SILO v0.2.0 — Secure AI Agent Sandbox Orchestrator*
