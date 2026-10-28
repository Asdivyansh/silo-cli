# CLI Reference

> Complete reference for every SILO command, flag, option, and output format.

---

## Global Options

| Flag | Description |
|---|---|
| `-V, --version` | Print the current SILO version |
| `-h, --help` | Show help for any command |

```bash
silo --version        # → 0.2.0
silo --help           # Show all commands
silo start --help     # Show help for a specific command
```

---

## Commands

### `silo onboard`

Interactive setup wizard. Configures the LLM provider, API key, model, workspace path, container resource limits, and security policy mode.

```bash
silo onboard [--force]
```

| Flag | Type | Default | Description |
|---|---|---|---|
| `-f, --force` | boolean | `false` | Overwrite existing configuration |

**Wizard Steps:**

| Step | Prompt | Example Values |
|---|---|---|
| 1 | LLM Provider | `openai`, `anthropic`, `local` |
| 2 | API Key | `sk-proj-abc123...`, `sk-ant-xyz...` |
| 3 | Model name | `gpt-4o`, `claude-sonnet-4-6`, `llama3` |
| 4 | Workspace path | `~/silo-workspace`, `./my-project` |
| 5a | CPU limit | `1.0` (one core), `2.0` (two cores) |
| 5b | Memory limit | `512m`, `1g`, `2g` |
| 6 | Security policy | **Strict (Default Deny)** or **Audit Only (Default Allow)** |

**Local provider extras:** When selecting `local`, an additional prompt asks for the base URL of your local inference server (default: `http://localhost:11434`).

**Security policy modes:**

| Mode | Default Action | Behaviour |
|---|---|---|
| **Strict (Default Deny)** | `deny` | Blocks all unknown traffic. Prompts you to approve new connections via the interactive interceptor. Auto-applies the `standard` preset (PyPI, npm, GitHub). |
| **Audit Only (Default Allow)** | `allow` | Allows all traffic but logs every request in the audit trail. Ideal for getting started quickly — lock down later by editing `~/.silo/policy.yaml`. |

**Config storage:**
- macOS: `~/Library/Preferences/cli-silo-nodejs/config.json`
- Linux: `~/.config/cli-silo-nodejs/config.json`

**Security:** Your API key is encrypted at rest using AES-256-GCM with a machine-bound key. It is never passed into the Docker container. The inference proxy decrypts and injects it at request time.

---

### `silo build`

Build the agent sandbox Docker image from `sandbox/Dockerfile`.

```bash
silo build [--tag <tag>] [--no-cache] [--framework <name>] [--all-frameworks] [--browser]
```

| Flag | Type | Default | Description |
|---|---|---|---|
| `-t, --tag <tag>` | string | `silo-sandbox:latest` | Override the Docker image tag |
| `--no-cache` | boolean | `false` | Pass `--no-cache` to `docker build` for a clean rebuild |
| `-f, --framework <name>` | string | — | Build a framework-specific image (e.g. `crewai`, `langgraph`) |
| `--all-frameworks` | boolean | `false` | Build framework images for every supported framework |
| `--browser` | boolean | `false` | Build a browser-capable framework image, e.g. `silo-sandbox-openclaw-browser:latest` |

**What the image includes:**
- Python 3.12 runtime (based on `python:3.12-slim`)
- System tools: `curl`, `git`, `jq`, `ca-certificates`
- Non-root user: `agent` (UID 1001, GID 1001)
- `/workspace` mount point (populated at runtime via `--volume`)
- `/skills` directory for custom agent skill scripts
- Custom `entrypoint.sh` that validates non-root execution, prints proxy config, loads skill scripts, and keeps the container alive

Browser-capable framework images additionally bake Chromium into the read-only image layer, expose common browser binary names through a SILO launcher, and use disposable runtime tmpfs mounts for browser cache/profile/downloads.

Use `silo build --all-frameworks --browser` to build browser-capable variants for every supported framework.

---

### `silo start`

Launch the full sandbox stack: Docker bridge network → inference proxy daemon → sandbox container.

```bash
silo start [--policy <file>] [--rebuild] [--name <agent>] [--workspace <path>] [--desktop] [--mount <spec>] [--framework <name>] [--browser]
```

| Flag | Type | Default | Description |
|---|---|---|---|
| `-p, --policy <file>` | string | from onboard | Path to a YAML policy file |
| `--rebuild` | boolean | `false` | Rebuild the sandbox image before starting |
| `-n, --name <agent>` | string | from config | Name the agent (creates container `silo-<name>`) |
| `-w, --workspace <path>` | string | from config | Override the workspace path for this agent |
| `--desktop` | boolean | `false` | Mount the host Desktop at `/host/Desktop` |
| `--mount <spec>` | string | — | Mount a host path into `/host/...`, e.g. `~/Downloads:/host/Downloads:ro` |
| `-f, --framework <name>` | string | — | Start with a specific framework (uses framework image) |
| `--browser` | boolean | `false` | Use the browser-capable variant of the selected framework image |

**Startup sequence:**

1. Reads and validates config from disk
2. Checks Docker availability
3. Guards against already-running containers (removes stale stopped containers)
4. Creates the `silo-sandbox-net` Docker bridge network (if not exists)
5. Spawns the inference proxy daemon on the host (detached, port `:8199`)
6. Starts the sandbox container with all security hardening flags
7. Writes `proxy.running = true` to config
8. Prints connection instructions

Additional host mounts are intentionally opt-in. Agents can always read and write `/workspace`, but they cannot see host paths like Desktop unless you start the sandbox with `--desktop` or an explicit `--mount`.

Browser mode is also opt-in and requires a framework image built with `silo build --framework <name> --browser`. It keeps `/tmp` hardened, adds isolated browser tmpfs mounts, sets `/dev/shm` to `512m`, and raises the container memory limit to at least `2g` for that run.

Capability profiles are additive:

| Profile | Scope |
|---|---|
| default | Safe coding, text, API, shell, and `/workspace` tasks |
| `--desktop` | Adds host Desktop at `/host/Desktop` |
| `--mount` | Adds explicit host folders under `/host/...` |
| `--browser` | Adds sandboxed Chromium for framework browser automation |

**Example output:**
```
╭──────────────────────────────────────╮
│  SILO  v0.2.0                        │
│  Secure AI Agent Sandbox Orchestrator│
╰──────────────────────────────────────╯

ℹ  Agent:     silo-agent
ℹ  Workspace: ~/silo-workspace
ℹ  Image:     silo-sandbox:latest
ℹ  Policy:    ~/.silo/policy.yaml (strict)

✔  Docker network "silo-sandbox-net" created
✔  Inference proxy running (pid=48291)
✔  Sandbox started (a3f1b2c4d5e6)

✔  Agent sandbox "silo-agent" is running.

  Commands:
    silo connect          — open an interactive shell
    silo status           — view resource usage
    silo policy apply pypi — allow pip installs
    silo stop             — shut down the sandbox
```

---

### `silo stop`

Gracefully shut down part or all of the SILO stack.

```bash
silo stop [--name <agent>] [--all]
```

| Flag | Type | Default | Description |
|---|---|---|---|
| `-n, --name <agent>` | string | — | Stop only a specific named agent (keeps proxy running) |
| `-a, --all` | boolean | `false` | Stop ALL running SILO agent containers |

**Shutdown sequence (for default/all):**

1. Stops and removes the sandbox container(s) (`docker stop` + `docker rm --force`)
2. Stops the inference proxy daemon (SIGTERM → wait 5s → SIGKILL if needed)
3. Logs a `session_stop` audit event
4. Writes `proxy.running = false` to config
5. Removes the `silo-sandbox-net` Docker network (if no other containers attached)

**Stopping a named agent:** When `--name` is used, only that specific container is stopped. The proxy and network remain active for other agents.

**Stopping all agents:** When `--all` is used, all containers with the `managed-by=silo` Docker label are discovered and stopped.

---

### `silo connect`

Open an interactive shell inside the running sandbox container.

```bash
silo connect [--shell <path>] [--name <agent>]
```

| Flag | Type | Default | Description |
|---|---|---|---|
| `-s, --shell <shell>` | string | `/bin/sh` | Shell binary to use (e.g. `/bin/bash`) |
| `-n, --name <agent>` | string | from config | Connect to a specific named agent |

**Auto-repair:** Before connecting, SILO checks if the proxy daemon is alive and healthy. If it has crashed, it is transparently restarted via `ensureProxyRunning()`.

**Inside the sandbox:**
```bash
# Check proxy connectivity
curl http://llm.gateway:8199/_silo/health

# Make an LLM call (API key injected by proxy)
curl http://llm.gateway:8199/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Hello"}]}'

# Exit (container keeps running)
exit
```

---

### `silo run <task>`

Run an LLM-powered agent task. SILO orchestrates the full tool-calling loop.

```bash
silo run <task> [--max-turns <n>] [--name <agent>] [--policy <file>] [--no-stream]
```

| Flag | Type | Default | Description |
|---|---|---|---|
| `-m, --max-turns <n>` | integer | `10` | Maximum conversation turns before stopping |
| `-n, --name <agent>` | string | from config | Run against a specific named agent |
| `-p, --policy <file>` | string | — | Policy file override |
| `--no-stream` | boolean | `false` | Disable streaming output |

**Execution loop:**

1. Sends the task to the LLM **via the local inference proxy** (audited + policy-checked)
2. When the LLM produces tool calls, executes them inside the sandbox via `docker exec --workdir /workspace`
3. Captures stdout, stderr, and exit code from each command
4. Feeds results back to the LLM as tool call responses
5. Loops until the LLM produces a final text response (no tool calls) or `--max-turns` is reached

**Tool definitions:**

The agent has access to three tools:

| Tool | Description |
|---|---|
| `execute_command` | Run a shell command. Returns stdout, stderr, exit code. |
| `read_file` | Read file contents with optional `max_lines` limit (default 200). |
| `write_file` | Write content to a file. Creates parent directories if needed. Executes securely via direct container process with stdin piping. |

```json
[
  {
    "name": "execute_command",
    "parameters": { "command": "string (required)" }
  },
  {
    "name": "read_file",
    "parameters": { "path": "string (required)", "max_lines": "number (optional, default 200)" }
  },
  {
    "name": "write_file",
    "parameters": { "path": "string (required)", "content": "string (required)" }
  }
]
```

**Timeouts:**
- Per-command execution timeout: **120 seconds**
- LLM request timeout: **120 seconds**

**Output truncation:**
- stdout displayed: first 2,000 characters
- stderr displayed: first 1,000 characters
- Tool result to LLM: stdout up to 8,000 chars, stderr up to 2,000 chars

**Provider support:** Supports both OpenAI and Anthropic function calling formats. The message format is automatically converted for Anthropic (tool_use/tool_result blocks).

---

### `silo list` / `silo ls`

List all running SILO agent containers.

```bash
silo list
silo ls
```

No flags. Uses the Docker label `managed-by=silo` to discover SILO-managed containers.

**Output columns:**

| Column | Description |
|---|---|
| Name | Container name (e.g. `silo-alpha`) |
| Status | `● running` or `● stopped` |
| Image | Docker image tag |
| Uptime | Running time |

---

### `silo status`

Show a comprehensive dashboard of the entire SILO stack.

```bash
silo status
```

**Dashboard sections:**

| Section | Information Displayed |
|---|---|
| **LLM Configuration** | Provider, model, masked API key, base URL |
| **Sandbox** | Container name/status, image, workspace, CPU/memory limits, live CPU/memory usage, uptime |
| **Policy** | Active policy file path, mode (strict/audit-only), and default action |
| **Inference Proxy** | Port, running status, PID, PID file path |
| **Audit** | Session ID, total requests, LLM requests, total tokens, audit log path |
| **Meta** | Config file path, onboard timestamp |

---

### `silo policy`

Parent command for managing sandbox egress policies. Has six subcommands.

#### `silo policy list`

Show all available built-in presets.

```bash
silo policy list
```

**Built-in presets:**

| Preset | Description | Allowed Hosts |
|---|---|---|
| `pypi` | Allow pip installs | `pypi.org`, `files.pythonhosted.org`, `*.pythonhosted.org` |
| `npm` | Allow npm/pnpm installs | `registry.npmjs.org`, `*.npmjs.org` |
| `github` | Allow Git clone + GitHub API | `github.com`, `api.github.com`, `raw.githubusercontent.com`, `objects.githubusercontent.com` |
| `huggingface` | Allow HF model downloads | `huggingface.co`, `cdn-lfs.huggingface.co`, `*.hf.co` |

#### `silo policy show`

Print the active policy rules with a preview of evaluation results.

```bash
silo policy show
```

Displays: file path, default action, all rules (host pattern, action, comment), and a preview test against `llm.gateway`, `api.openai.com`, and `evil.example.com`.

#### `silo policy apply <preset>`

Merge a preset's rules into the active policy.

```bash
silo policy apply <preset>
```

- If no policy file exists, creates one at `~/.silo/policy.yaml` from the baseline (using the mode chosen during onboard)
- Merges rules idempotently — applying the same preset twice adds no duplicates
- Auto-reloads the running proxy daemon via SIGHUP

#### `silo policy remove <preset>`

Remove a preset's rules from the active policy.

```bash
silo policy remove <preset>
```

Rules are matched by host pattern only — the action/comment may differ if the user edited them.

#### `silo policy add <host>`

Add a single host rule without editing YAML files.

```bash
silo policy add <host> [--action <allow|deny>] [--comment <text>]
```

| Flag | Type | Default | Description |
|---|---|---|---|
| `--action <action>` | string | `allow` | Rule action: `allow` or `deny` |
| `--comment <text>` | string | — | Optional comment for the rule |

- **Idempotent** — skips if the host already exists in the policy
- **Auto-creates** the policy file if it doesn't exist
- **Auto-reloads** the proxy daemon via SIGHUP
- **Persists** the policy file path in config if not already set

#### `silo policy reload`

Hot-reload the active policy without restarting the proxy.

```bash
silo policy reload
```

Sends `SIGHUP` to the proxy daemon process. The daemon re-reads and recompiles the YAML policy file without dropping connections.

---

### `silo integrations` / `silo int`

Parent command for managing credential-managed API integrations. Has five subcommands.

#### `silo integrations add <service>`

Add a new integration. Uses a built-in template if one exists for the service, otherwise launches an interactive wizard.

```bash
silo integrations add slack          # Template-based (prompts for token only)
silo integrations add my-custom-api  # Custom (prompts for URL, auth type, token)
```

**Built-in templates:**

| Template | Service | Base URL | Auth Type | Token Hint |
|---|---|---|---|---|
| `slack` | Slack | `https://slack.com/api` | Bearer | `xoxb-...` |
| `github` | GitHub | `https://api.github.com` | Bearer | `ghp_...` or `github_pat_...` |
| `hubspot` | HubSpot | `https://api.hubapi.com` | Bearer | `pat-...` |
| `linear` | Linear | `https://api.linear.app` | Bearer | `lin_api_...` |
| `notion` | Notion | `https://api.notion.com` | Bearer | `secret_...` |

**Custom integration prompts:**

| Prompt | Description |
|---|---|
| API base URL | e.g. `https://api.example.com` |
| Auth type | `bearer`, `header` (custom header), or `query` (URL parameter) |
| Header name | Only for `header` auth — e.g. `x-api-key` |
| Query param name | Only for `query` auth — e.g. `api_key` |
| API token | Masked input, never displayed |

**Gateway:** Each integration gets a gateway alias `<name>.gateway` (e.g. `slack.gateway`). The sandbox container can reach it at `http://slack.gateway:8199`.

**Important:** Restart the sandbox (`silo stop && silo start`) after adding new integrations for the DNS alias to take effect.

#### `silo integrations list`

List all configured integrations with their gateway, base URL, auth type, and masked token.

```bash
silo integrations list
silo int list
```

#### `silo integrations remove <name>`

Remove a configured integration by name.

```bash
silo integrations remove slack
```

#### `silo integrations test <name>`

Test basic HTTPS connectivity to the integration's base URL.

```bash
silo integrations test github
```

Makes a simple HTTPS GET to the base URL and reports the status code. Does **not** inject credentials — this is a connectivity check only.

#### `silo integrations templates`

List all available built-in integration templates.

```bash
silo integrations templates
```

---

### `silo logs`

View the unified audit trail — LLM calls, LLM request messages, tool calls, egress, blocked requests, framework traces.

```bash
silo logs [--tail <n>] [--category <cat>] [--verdict <v>] [--since <duration>] [--framework <name>] [--agent <name>] [--follow] [--json]
```

| Flag | Type | Default | Description |
|---|---|---|---|
| `-n, --tail <count>` | integer | `20` | Number of entries to show |
| `-c, --category <cat>` | string | — | Filter: `llm`, `llm_message`, `egress`, `blocked`, `integration`, `tool_call`, or `trace` |
| `-v, --verdict <v>` | string | — | Filter: `allow` or `deny` |
| `-s, --since <duration>` | string | — | Time filter: `30m`, `2h`, `1d`, `1w` |
| `--framework <name>` | string | — | Filter by framework (e.g. `crewai`, `langgraph`) |
| `--agent <name>` | string | — | Filter by agent name |
| `-F, --follow` | boolean | `false` | Follow the audit log in real-time (like `tail -f`) |
| `--json` | boolean | `false` | Output raw JSONL for piping |

**Table columns (formatted mode):**

| Column | Description |
|---|---|
| Time | Local time (HH:MM:SS format) |
| Category | `llm`, `llm_message`, `egress`, `blocked`, `integration`, `tool_call`, or `trace` |
| Verdict | `allow` or `deny` |
| Method | HTTP method (or `MESSAGE` / `TOOL_CALL` / `TRACE`) |
| Host | Target hostname (truncated to 26 chars) |
| Status | HTTP status code |
| Latency | Round-trip time in ms |
| Detail | Framework name, tool name, agent name, or trace event |

**Duration format:**

| Suffix | Meaning | Example |
|---|---|---|
| `s` | seconds | `30s` |
| `m` | minutes | `30m` |
| `h` | hours | `2h` |
| `d` | days | `1d` |
| `w` | weeks | `1w` |

**Piping examples:**

```bash
# Count blocked requests
silo logs --json --verdict deny | wc -l

# List all unique hosts accessed
silo logs --json | jq -r '.host' | sort -u

# Export LLM latency data
silo logs --json --category llm | jq '{time: .timestamp, latency: .latencyMs, model: .model}'

# Inspect individual request message previews
silo logs --json --category llm_message | jq '{role: .messageRole, preview: .messagePreview}'

# See all tool calls
silo logs --json --category tool_call | jq '.toolName'

# All activity from a specific agent
silo logs --framework crewai --agent Researcher

# Full audit export
silo logs --json > audit-export.jsonl
```

---

### `silo traces`

Convenience alias for viewing framework trace events.

```bash
silo traces [--tail <n>] [--framework <name>] [--agent <name>] [--since <duration>] [--json]
```

Equivalent to `silo logs --category trace --category tool_call` with the same filtering options.

---

### `silo frameworks`

Manage supported agent frameworks.

#### `silo frameworks list`

List all available frameworks with descriptions, install methods, and icons.

```bash
silo frameworks list
```

#### `silo frameworks info <id>`

Show detailed information about a specific framework.

```bash
silo frameworks info crewai
```

Displays: name, description, version, install method, packages, required policies, health check command, tags, and docs URL.

---

### `silo snapshot`

Save and restore container state.

#### `silo snapshot create <name>`

Create a Docker commit of the current sandbox state.

```bash
silo snapshot create "clean-install"
```

#### `silo snapshot list`

List all saved snapshots.

```bash
silo snapshot list
```

#### `silo snapshot rollback <name>`

Restore the sandbox to a previous snapshot.

```bash
silo snapshot rollback "clean-install"
```

#### `silo snapshot delete <name>`

Delete a saved snapshot.

```bash
silo snapshot delete "clean-install"
```

---

### `silo doctor`

Run diagnostic checks on the SILO environment.

```bash
silo doctor
```

Checks: Node.js version, Docker availability, Docker daemon status, config file existence, proxy health, container status.

---

### `silo quickstart`

Zero-to-sandbox in one command. Combines onboard → build → start → connect.

```bash
silo quickstart [--framework <name>] [--browser]
```

| Flag | Type | Default | Description |
|---|---|---|---|
| `-f, --framework <name>` | string | — | Build and start with a specific framework |
| `--browser` | boolean | `false` | Use the browser-capable framework image and runtime profile |

Skips steps that are already done (already onboarded, image already built, container already running).

---

## Command Summary Table

| Command | Description |
|---|---|
| `silo quickstart [--framework] [--browser]` | Zero-to-sandbox in one command |
| `silo onboard [--force]` | Interactive setup wizard |
| `silo doctor` | System diagnostics |
| `silo build [--tag] [--no-cache] [--framework] [--all-frameworks] [--browser]` | Build the sandbox Docker image |
| `silo start [--policy] [--rebuild] [--name] [--workspace] [--desktop] [--mount] [--framework] [--browser]` | Launch sandbox + proxy |
| `silo stop [--name] [--all]` | Shut down the stack |
| `silo connect [--shell] [--name]` | Shell into the sandbox |
| `silo run <task> [--max-turns N] [--name]` | Run an LLM agent task |
| `silo list` / `silo ls` | List running agents |
| `silo status` | Health dashboard |
| `silo logs [--tail] [--category] [--verdict] [--since] [--framework] [--agent] [--follow] [--json]` | View unified audit trail |
| `silo traces [--tail] [--framework] [--agent] [--since] [--json]` | View framework traces |
| `silo frameworks list` | List available frameworks |
| `silo frameworks info <id>` | Framework details |
| `silo policy list` | List presets |
| `silo policy show` | Print active policy |
| `silo policy apply <preset>` | Merge a preset |
| `silo policy remove <preset>` | Remove a preset |
| `silo policy add <host> [--action] [--comment]` | Add a single rule |
| `silo policy reload` | Hot-reload policy |
| `silo integrations add <service>` | Add integration (Slack, GitHub, etc.) |
| `silo integrations list` / `silo int list` | List integrations |
| `silo integrations remove <name>` | Remove an integration |
| `silo integrations test <name>` | Test integration connectivity |
| `silo integrations templates` | List built-in templates |
| `silo snapshot create <name>` | Save container state |
| `silo snapshot list` | List snapshots |
| `silo snapshot rollback <name>` | Restore a snapshot |
| `silo snapshot delete <name>` | Delete a snapshot |

---

*SILO v0.2.0 — Secure AI Agent Sandbox Orchestrator*
