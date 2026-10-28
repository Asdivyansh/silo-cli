# Multi-Agent Support

> Running multiple isolated agents simultaneously with shared infrastructure.

---

## Overview

SILO supports running multiple isolated agents concurrently. Each agent gets its own Docker container with an independent workspace and resource limits. All agents share a single proxy daemon instance.

---

## How It Works

### Naming Convention

- Each agent is identified by a name provided via `--name <agent>`
- Container names follow the pattern `silo-<name>` (e.g., `silo-alpha`, `silo-frontend`)
- The default agent (no `--name`) uses the name from config (`silo-agent`)

### Resource Sharing

| Resource | Shared? | Details |
|---|---|---|
| Proxy daemon | ✅ Shared | Single proxy instance serves all agents |
| Docker network | ✅ Shared | All agents on `silo-sandbox-net` |
| Audit log | ✅ Shared | All requests logged to the same `audit.jsonl` |
| Container | ❌ Isolated | Each agent has its own container |
| Workspace | ❌ Isolated | Each agent can have a different workspace path |
| Resource limits | ❌ Per-agent | CPU/memory limits apply per container |

### Container Discovery

All SILO containers are labelled with `managed-by=silo`. This label is used by:
- `silo list` — discovers all SILO containers
- `silo stop --all` — stops all SILO containers
- Network cleanup — checks if any SILO containers are still attached

---

## Workflow

### Starting Multiple Agents

```bash
# Start agents with different workspaces
silo start --name frontend --workspace ~/projects/frontend
silo start --name backend --workspace ~/projects/backend
silo start --name data-pipeline --workspace ~/projects/etl
```

### Listing Running Agents

```bash
silo list
```

```
Running Agents

┌──────────────────┬───────────┬──────────────────────┬───────────────┐
│ Name             │ Status    │ Image                │ Uptime        │
├──────────────────┼───────────┼──────────────────────┼───────────────┤
│ silo-frontend    │ ● running │ silo-sandbox:latest  │ 12 minutes    │
│ silo-backend     │ ● running │ silo-sandbox:latest  │ 8 minutes     │
│ silo-data-pipeline│ ● running │ silo-sandbox:latest  │ 3 minutes     │
└──────────────────┴───────────┴──────────────────────┴───────────────┘

ℹ Total: 3 agent(s)
```

### Running Tasks Against Specific Agents

```bash
# In terminal 1
silo run "Add dark mode support" --name frontend

# In terminal 2
silo run "Add rate limiting to the API" --name backend

# In terminal 3
silo run "Write ETL pipeline for user data" --name data-pipeline
```

### Connecting to Specific Agents

```bash
silo connect --name frontend
# Opens a shell in silo-frontend

silo connect --name backend
# Opens a shell in silo-backend
```

### Stopping Individual Agents

```bash
# Stop just the frontend agent (proxy and other agents keep running)
silo stop --name frontend
```

### Stopping All Agents

```bash
# Stop everything — all containers + proxy + network
silo stop --all
```

---

## Proxy Behaviour with Multiple Agents

The single proxy daemon serves all agents identically:

1. All containers route through the same `http_proxy` endpoint
2. The same policy is applied to all agents (policy is global, not per-agent)
3. All requests are logged to the same audit trail with the same `sessionId`
4. Credential injection is identical — all agents use the same configured LLM provider/key

### Implications

- **Agents cannot interfere with each other** — they are in separate containers
- **Agents share the same egress policy** — you cannot have different policies per agent
- **Audit entries from different agents are interleaved** — filter by container name if needed (not currently available in the audit format, but the timing and host patterns can differentiate)

---

## Example: Full Multi-Agent Workflow

```bash
# 1. Set up SILO
silo onboard
silo build

# 2. Start multiple agents
silo start --name alpha --workspace ~/project-a
silo start --name beta --workspace ~/project-b

# 3. Apply policies for both
silo policy apply pypi
silo policy apply github

# 4. Run tasks in parallel (separate terminals)
silo run "Write unit tests for the auth module" --name alpha
silo run "Add database migration scripts" --name beta

# 5. Monitor all agents
silo list

# 6. Review what happened
silo logs --category llm --since 1h

# 7. Clean up
silo stop --name alpha    # Stop one
silo stop --name beta     # Stop another
# or
silo stop --all           # Stop everything at once
```

---

## Limitations

1. **No per-agent policies** — all agents share the same egress policy
2. **No per-agent audit filtering** — the audit log doesn't track which container originated each request
3. **Shared LLM credentials** — all agents use the same API key
4. **Single proxy port** — all agents connect to the same proxy port (`:8199`)
5. **Manual coordination** — there is no built-in inter-agent communication or task orchestration

---

*SILO v0.2.0 — Secure AI Agent Sandbox Orchestrator*
