# Security Model

> Complete reference for SILO's defence-in-depth security architecture.

---

## Overview

SILO implements **defence in depth** across six isolation layers. Each layer is independent — even if one layer is compromised, the remaining layers continue to provide protection.

| Layer | Threat Mitigated | Mechanism |
|---|---|---|
| **Container Hardening** | Privilege escalation, system damage | Non-root, read-only FS, no capabilities, PID limits |
| **Network Isolation** | Data exfiltration, C2 communication | Native Linux no-NAT bridge; Docker Desktop proxy-routed egress with proxy source allowlist |
| **Policy Engine** | Unauthorised outbound access | YAML rules evaluated per-request, deny by default |
| **Credential Isolation** | API key theft | Keys stored host-side, injected at request time |
| **Encryption at Rest** | Config file theft, key exposure | AES-256-GCM with machine-bound PBKDF2 key |
| **Integration Isolation** | Third-party API token theft | Same proxy injection pattern; tokens never enter container |

---

## Layer 1: Container Hardening

Every sandbox container is launched with a comprehensive set of security flags that enforce the principle of least privilege.

### Docker Run Security Flags

| Flag | Purpose | Threat Mitigated |
|---|---|---|
| `--user 1001:1001` | Non-root UID/GID execution | Host privilege escalation via root |
| `--read-only` | Immutable root filesystem | Malware persistence, binary replacement |
| `--tmpfs /tmp:size=64m,noexec,nosuid` | Ephemeral writable scratch space | Executable injection via /tmp, setuid attacks |
| `--cap-drop ALL` | All Linux capabilities removed | Raw socket operations, kernel module loading, privileged port binding |
| `--security-opt no-new-privileges` | Block setuid/setgid escalation | Privilege escalation via SUID binaries |
| `--pids-limit 128` | Limit number of processes | Fork bombs, resource exhaustion |
| `--cpus <n>` | CPU throttle | CPU resource exhaustion |
| `--memory <m>` | Memory cap | Memory resource exhaustion |

### Filesystem Layout

| Path | Mode | Purpose |
|---|---|---|
| `/` (root) | **read-only** | Immutable base system |
| `/tmp` | writable, `noexec`, `nosuid` | Ephemeral scratch (64MB cap, no executables) |
| `/workspace` | writable | User project files (host volume mount) |
| `/skills` | read-only | Agent skill scripts (optional bind mount) |

### What the Agent Cannot Do

- ❌ Escalate to root (runs as UID 1001, no capabilities)
- ❌ Install system packages (`apt-get` fails on read-only FS)
- ❌ Execute binaries from `/tmp` (`noexec` flag)
- ❌ Bind privileged ports (< 1024, no `CAP_NET_BIND_SERVICE`)
- ❌ Load kernel modules (no `CAP_SYS_MODULE`)
- ❌ Perform raw socket operations (no `CAP_NET_RAW`)
- ❌ Modify the container image (read-only FS)
- ❌ Fork bomb the host (`--pids-limit 128`)

### What the Agent Can Do

- ✅ Read/write files in `/workspace`
- ✅ Write temporary files to `/tmp` (up to 64MB)
- ✅ Run Python scripts, use git/curl/jq
- ✅ Call LLMs through the proxy at `http://llm.gateway:8199`
- ✅ Install Python packages via pip (if policy allows PyPI access)
- ✅ Call integration APIs through gateways (e.g. `http://slack.gateway:8199`)

---

## Layer 2: Network Isolation

### SILO Docker Bridge

The sandbox container runs on `silo-sandbox-net`, a Docker bridge network created with the `--internal` flag on **every platform**:

```bash
docker network create --driver bridge --internal --label managed-by=silo silo-sandbox-net
```

**Key property:** an internal bridge has **no default NAT gateway**. This means containers on this network **cannot route to the public internet directly**. All outbound HTTP traffic must flow through the configured proxy.

> [!NOTE]
> **Docker Desktop (macOS/Windows) Network Handling:**
> Under Docker Desktop, containers run inside a VM, so an `--internal` network has no route back to the host-side inference proxy via `host-gateway`. SILO bridges this gap with a dedicated **egress gateway sidecar**: a minimal `socat` relay container (`silo-gateway`) attached to both the internal sandbox network (carrying the `llm.gateway` and integration-gateway DNS aliases) and the default bridge, forwarding TCP to the host proxy via `host.docker.internal`. The sandbox itself stays on the strictly isolated internal network with no direct internet route — the sidecar relays only the proxy port, and is itself hardened (non-root, read-only, `--cap-drop ALL`, pids/memory limits).

### Traffic Routing

```
Container → http_proxy env var → llm.gateway:8199 → Host proxy → Internet
```

1. Standard HTTP clients (curl, Python requests, pip, npm) respect the `http_proxy` / `https_proxy` environment variables
2. These variables are set to `http://llm.gateway:<port>` inside the container
3. `llm.gateway` resolves to the host machine's IP via `--add-host llm.gateway:host-gateway` on native Linux, or to the egress gateway sidecar's DNS alias on Docker Desktop
4. Every request hits the host-side proxy, which evaluates it against the policy

### DNS Resolution

On native Linux, `llm.gateway` is injected via Docker's `--add-host` mechanism, which adds an entry to `/etc/hosts` inside the container. On Docker Desktop, it is a Docker network alias of the gateway sidecar, resolved by Docker's embedded DNS on the sandbox network. Neither path requires external DNS resolution.

---

## Layer 3: Policy Engine

### Default Posture: Configurable

During `silo onboard`, you choose between two modes:

**Strict (Default Deny)** — the built-in default policy blocks all outbound network egress except the inference proxy and pre-allowed hosts (PyPI, npm, GitHub via the `standard` preset):

```yaml
version: "1"
name: "strict"
default: deny
rules:
  - host: "llm.gateway"
    action: allow
  # + standard preset rules (pypi, npm, github)
```

**Audit Only (Default Allow)** — all traffic is permitted and fully logged, ideal for understanding what an agent needs before locking down:

```yaml
version: "1"
name: "audit-only"
default: allow
rules:
  - host: "llm.gateway"
    action: allow
```

**Host loopback is always blocked.** The proxy runs on the host, so `localhost`, `127.0.0.0/8`, `::1` and `0.0.0.0` would reach the host's own services (databases, dev servers, the Docker API). The proxy refuses these destinations for both plain HTTP and CONNECT, whatever the policy says, and also refuses hostnames whose DNS answer contains a loopback address.

### Per-Request Evaluation

Every outbound request from the container is evaluated against the active policy:

1. The proxy extracts the target hostname from the request URL or Host header
2. Rules are evaluated **top-to-bottom** — first match wins
3. Glob patterns (via picomatch) support wildcards: `*.pypi.org`, `**.example.com`, `{a,b}.org`
4. If no rule matches, the `default` action applies
5. Denied requests trigger the **interceptor** (see below)

### Interactive Interceptor

When a request is denied by policy, the interceptor provides three options:

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

- **Allow once** — Permits this specific request, not persisted
- **Allow always** — Adds the host to the active policy YAML file permanently, triggers a live policy recompile in the proxy daemon (no restart needed)
- **Deny** — Blocks the request, returns HTTP 403

**Non-TTY mode (Prompt IPC Loop):** When running headless (CI, daemon), if an interactive foreground Prompt Listener is active (e.g. from `silo run` or `silo connect`), denied requests are queued for up to 30 seconds. The active listener polls the proxy daemon via REST endpoints (`GET /_silo/prompts` and `POST /_silo/prompts/:id/decision`). These endpoints only answer loopback clients that present the daemon's control token (`x-silo-control-token`), which the daemon writes to `~/.silo/proxy-control.token` with mode `0600` on each start; the sandbox cannot read it, so it cannot list or answer its own prompts and prompts the operator in their interactive terminal. If no foreground listener is active, or the prompt times out, the request is automatically blocked and logged.

### CONNECT Tunnel Protection

HTTPS CONNECT requests to `llm.gateway` and all integration gateways (e.g. `slack.gateway`) are **explicitly rejected** with a 400 Bad Request. The agent must use plain HTTP so the proxy can:
- Inspect the request body
- Extract token usage from responses (LLM only)
- Inject credentials
- Record audit entries

---

## Layer 4: Credential Isolation

### Key Storage

API keys and integration tokens are stored **exclusively on the host** in the `conf` config store:
- macOS: `~/Library/Preferences/cli-silo-nodejs/config.json`
- Linux: `~/.config/cli-silo-nodejs/config.json`

**Encryption at rest:** All secrets (LLM API keys and integration tokens) are encrypted using **AES-256-GCM** before writing to disk. The encryption key is derived via PBKDF2 from machine-specific identifiers (`hostname` + `homedir`), making the config file non-portable between machines.

- Encrypted format: `enc:v1:<iv>:<authTag>:<ciphertext>` (all hex-encoded)
- `ensureEncrypted` / `ensureDecrypted` helpers enable transparent migration from plaintext configs
- Decryption happens automatically on `readConfig()`, encryption on `writeConfig()`

The container environment has **zero access** to API keys or integration tokens. They are not passed via environment variables, configuration files, volume mounts, or any other mechanism accessible to the container.

### Credential Injection

The inference proxy injects credentials at request time:

```
Container request (no auth headers)
  │
  ▼
Proxy strips any auth headers from the container
  │
  ▼
Proxy injects the real API key based on the target:
  ├─ llm.gateway:
  │   ├─ OpenAI:    Authorization: Bearer sk-...
  │   ├─ Anthropic: x-api-key: sk-ant-...  +  anthropic-version: 2023-06-01
  │   └─ Local:     Authorization: Bearer <key>  (if key ≠ "local")
  │
  └─ <service>.gateway:  (e.g. slack.gateway, github.gateway)
      ├─ Bearer:  Authorization: Bearer <token>
      ├─ Header:  <authHeader>: <token>
      └─ Query:   ?<param>=<token> appended to URL
```

### Auth Header Stripping

The proxy strips the following headers from container requests before forwarding:

| Header | Purpose |
|---|---|
| `authorization` | Standard bearer token |
| `x-api-key` | Anthropic API key |
| `api-key` | Azure OpenAI API key |
| `openai-api-key` | Alternative OpenAI key header |
| `anthropic-api-key` | Alternative Anthropic key header |

This prevents:
- **Key forgery** — A compromised agent cannot inject a malicious API key
- **Key exfiltration** — Even if the agent somehow guesses a key format, it cannot use Auth headers to exfiltrate it to a third party (the header is stripped)

---

## Additional Protections

### Proxy Health & Auto-Restart

- The proxy exposes `/_silo/health` — returns `{"status":"ok","pid":<n>,"uptimeMs":<n>}`
- `silo connect` and `silo run` check proxy health before proceeding
- If the proxy has crashed, it is transparently restarted
- No separate watchdog process needed — health checks are embedded in the CLI

### Audit Trail

- Every request through the proxy is recorded in `~/.silo/audit.jsonl`
- Entries include: timestamp, session ID, method, host, URL, category, verdict, status code, latency, model, token usage
- Automatic log rotation at 10MB (configurable via `SILO_LOG_MAX_BYTES`)
- Interceptor decisions are also logged in `~/.silo/blocked-requests.jsonl`
- Session lifecycle events (`session_start`, `session_stop`) are recorded

### Safe Subprocess Execution

All Docker commands are executed via `execa` with **argument arrays** — never through `child_process.exec` with string interpolation. This eliminates shell injection attacks.

```typescript
// SAFE — execa with argument array
await execa("docker", ["run", "--name", containerName, ...flags]);

// NEVER done — vulnerable to injection
exec(`docker run --name ${containerName} ${flags.join(" ")}`);
```

Similarly, the agent runner's file tools (`read_file` and `write_file`) execute container processes (`head` and `tee` respectively) via secure argument arrays (`executeArgsInContainer`), rather than passing commands to a shell interpreter like `/bin/sh -c`. For `write_file`, the file contents are piped directly over stdin to the `tee` process, completely eliminating shell injection vulnerability through file content or path parameters.

### Container Discovery

SILO-managed containers are identified by the `managed-by=silo` Docker label. This ensures:
- `silo list` only shows SILO containers
- `silo stop --all` only stops SILO containers
- No interference with other Docker workloads on the host

---

## Threat Model Summary

| Threat | Mitigation |
|---|---|
| Agent exfiltrates API keys via POST | Container has no access to keys; auth headers are stripped |
| Agent executes `rm -rf /` or destructive commands | Read-only filesystem; only `/workspace` and `/tmp` are writable |
| Agent spawns crypto miner or fork bomb | `--pids-limit 128`, CPU/memory throttles |
| Agent connects to C2 server | Policy engine denies by default; native Linux also removes direct internet routing with a no-NAT bridge |
| Agent escalates to root | `--user 1001:1001`, `--cap-drop ALL`, `no-new-privileges` |
| Agent exfiltrates data via DNS | DNS resolution routes through the proxy for HTTP/HTTPS traffic |
| Agent modifies container image to persist malware | `--read-only` filesystem |
| Agent writes executable to /tmp and runs it | `noexec` flag on `/tmp` tmpfs mount |
| Agent tries to forge API credentials | Auth headers from container are stripped before forwarding |
| Agent steals integration API tokens | Integration tokens stored host-side only; same proxy injection pattern |
| Proxy daemon crashes silently | Health check endpoint + auto-restart in `silo connect`/`silo run` |
| Config file stolen from disk | API keys encrypted at rest (AES-256-GCM, machine-bound key) |
| Config file moved to another machine | PBKDF2 key derivation uses hostname + homedir; decryption fails |
| Audit log grows unbounded | Automatic rotation at 10MB (5 rotated files) |

---

## Security Comparison: Without SILO vs. With SILO

| Scenario | Without SILO | With SILO |
|---|---|---|
| API key exposure | Agent can read `$OPENAI_API_KEY` | Key never enters the container |
| Network access | Agent can reach any host | Only policy-approved hosts |
| File system | Full read-write access | Read-only root, writable `/workspace` only |
| Privilege level | Often runs as root | Non-root UID 1001, no capabilities |
| Audit trail | No visibility | Every request logged with timing and tokens |
| Resource limits | Unlimited | CPU/memory/PID throttled |
| Observability | None | Real-time status, audit logs, interceptor prompts |

## Security for External Agents

When running an external agent framework (OpenClaw, AutoGPT, CrewAI, etc.) inside SILO, all four security layers work together transparently.

### What Happens When an External Agent Makes an LLM Call

```
1. Agent code calls OpenAI SDK
   → SDK sends POST to http://llm.gateway:8199/v1/chat/completions
   → No API key attached (agent doesn't have one)

2. Layer 2 (Network): Request routes through the SILO bridge
   → Standard HTTP clients are configured to use the proxy

3. Layer 3 (Policy): Proxy recognises llm.gateway
   → Always allowed — this is the LLM inference path

4. Layer 4 (Credentials): Proxy strips any auth headers from the request
   → Injects the real API key from host-side config
   → Rewrites Host header to api.openai.com
   → Forwards via HTTPS

5. Audit: Request logged with method, host, model, tokens, latency

6. Response streamed back to agent inside the container
```

### What Happens When an External Agent Tries to Exfiltrate Data

```
1. Compromised agent sends POST to http://evil.example.com/exfiltrate
   → Request body contains stolen source code

2. Layer 2 (Network): Standard HTTP clients route through the proxy
   → Native Linux also has no direct internet route because of the internal bridge

3. Layer 3 (Policy): Proxy evaluates policy
   → evil.example.com is not in the allowed list
   → Default action: deny

4. Interceptor: If running with TTY, operator sees:
   ⚠  Sandbox is requesting access to an unauthorised host
     Method : POST
     Host   : evil.example.com
   → Operator chooses: Deny

5. Response: HTTP 403 "Blocked by SILO policy: evil.example.com"

6. Audit: Recorded as category=blocked, verdict=deny
```

### External Agent Security Recommendations

| Recommendation | Why |
|---|---|
| Start with **Strict mode** or review audit logs regularly | Discover what the agent actually needs, don't guess |
| Use **Allow once** before **Allow always** | Test that a host is truly needed before persisting |
| Set a **low `--max-turns`** when testing new agents | Prevent runaway loops while evaluating behavior |
| Review **`silo logs --verdict deny`** after each session | Understand what the agent tried to access |
| Use **separate workspaces** per agent | Prevent cross-contamination between projects |
| Mount workspaces with **only necessary files** | Don't mount your entire home directory |

> **📖 Full guide:** [Running External Agents](./sandbox-agents.md) | [Integration Patterns](./integration-patterns.md)

---

*SILO v0.2.0 — Secure AI Agent Sandbox Orchestrator*
