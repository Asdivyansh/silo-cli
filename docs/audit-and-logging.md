# Audit & Logging

> Complete reference for SILO's unified JSONL audit trail — covering LLM calls, tool calls, framework traces, egress, integrations, log rotation, filtering, and forensic analysis.

---

## Overview

SILO records every request flowing through the inference proxy in a persistent, append-only JSONL audit trail. This provides complete visibility into what the agent did, when, and whether it was allowed.

**Log location:** `~/.silo/audit.jsonl`

---

## Audit Entry Format

Each line in the audit log is a self-contained JSON object:

### Full Entry (LLM Request)

```json
{
  "timestamp": "2026-04-11T18:30:12.456Z",
  "sessionId": "a3f1b2c4-d5e6-7890-abcd-ef1234567890",
  "method": "POST",
  "host": "llm.gateway",
  "url": "http://llm.gateway:8199/v1/chat/completions",
  "category": "llm",
  "verdict": "allow",
  "statusCode": 200,
  "latencyMs": 1423,
  "ttfbMs": 911,
  "requestBytes": 4182,
  "responseBytes": 2380,
  "llmRequestId": "8d4e6a9f-5b71-4cfd-984e-5b46f88d3c9a",
  "messagesSent": 12,
  "promptTokens": 845,
  "completionTokens": 214,
  "totalTokens": 1059,
  "model": "gpt-4o",
  "framework": "crewai"
}
```

### LLM Message Entry

Each LLM request also records one local `llm_message` entry per request message, correlated back to the parent LLM request with `llmRequestId`:

```json
{
  "timestamp": "2026-04-11T18:30:12.111Z",
  "sessionId": "a3f1b2c4-d5e6-7890-abcd-ef1234567890",
  "method": "MESSAGE",
  "host": "llm.gateway",
  "url": "http://llm.gateway:8199/v1/chat/completions",
  "category": "llm_message",
  "verdict": "allow",
  "statusCode": 0,
  "latencyMs": 0,
  "model": "gpt-4o",
  "framework": "openclaw",
  "llmRequestId": "8d4e6a9f-5b71-4cfd-984e-5b46f88d3c9a",
  "messageIndex": 3,
  "messageRole": "user",
  "messageContentType": "text",
  "messagePreview": "Open the README and summarize the browser mode section.",
  "messageChars": 57
}
```

### Egress Entry (Allowed External Request)

```json
{
  "timestamp": "2026-04-11T18:31:02.789Z",
  "sessionId": "a3f1b2c4-d5e6-7890-abcd-ef1234567890",
  "method": "GET",
  "host": "pypi.org",
  "url": "http://pypi.org/simple/requests/",
  "category": "egress",
  "verdict": "allow",
  "statusCode": 200,
  "latencyMs": 156
}
```

### Blocked Entry

```json
{
  "timestamp": "2026-04-11T18:32:10.123Z",
  "sessionId": "a3f1b2c4-d5e6-7890-abcd-ef1234567890",
  "method": "POST",
  "host": "evil.example.com",
  "url": "http://evil.example.com/exfiltrate",
  "category": "blocked",
  "verdict": "deny",
  "statusCode": 403,
  "latencyMs": 2
}
```

### Integration Entry

```json
{
  "timestamp": "2026-04-11T18:33:15.456Z",
  "sessionId": "a3f1b2c4-d5e6-7890-abcd-ef1234567890",
  "method": "POST",
  "host": "slack.gateway",
  "url": "http://slack.gateway:8199/chat.postMessage",
  "category": "integration",
  "verdict": "allow",
  "statusCode": 200,
  "latencyMs": 342,
  "service": "slack"
}
```

### Session Event

```json
{
  "timestamp": "2026-04-11T18:25:00.000Z",
  "sessionId": "a3f1b2c4-d5e6-7890-abcd-ef1234567890",
  "method": "INTERNAL",
  "host": "silo",
  "url": "session_start",
  "category": "egress",
  "verdict": "allow",
  "statusCode": 0,
  "latencyMs": 0
}
```

### Tool Call Entry

```json
{
  "timestamp": "2026-04-11T18:30:14.789Z",
  "sessionId": "a3f1b2c4-d5e6-7890-abcd-ef1234567890",
  "method": "TOOL_CALL",
  "host": "llm.gateway",
  "url": "/v1/chat/completions",
  "category": "tool_call",
  "verdict": "allow",
  "statusCode": 200,
  "latencyMs": 0,
  "toolName": "read_file",
  "toolCallId": "call_abc123",
  "toolArgs": "{\"path\":\"/workspace/main.py\"}",
  "framework": "crewai"
}
```

### Trace Entry

```json
{
  "timestamp": "2026-04-11T18:30:15.123Z",
  "sessionId": "a3f1b2c4-d5e6-7890-abcd-ef1234567890",
  "method": "TRACE",
  "host": "framework",
  "url": "crewai/Researcher/agent_start",
  "category": "trace",
  "verdict": "allow",
  "statusCode": 0,
  "latencyMs": 0,
  "framework": "crewai",
  "agent": "Researcher",
  "traceEvent": "agent_start"
}
```

---

## Entry Fields

| Field | Type | Always Present | Description |
|---|---|---|---|
| `timestamp` | ISO-8601 string | ✅ | When the request was processed |
| `sessionId` | UUID string | ✅ | Proxy session identifier (new per daemon start) |
| `method` | string | ✅ | HTTP method (`GET`, `POST`, `CONNECT`, `INTERNAL`, `MESSAGE`, `TOOL_CALL`, `TRACE`) |
| `host` | string | ✅ | Target hostname |
| `url` | string | ✅ | Full URL or `host:port` for CONNECT tunnels |
| `category` | string | ✅ | `llm`, `llm_message`, `egress`, `blocked`, `integration`, `tool_call`, or `trace` |
| `verdict` | string | ✅ | `allow` or `deny` |
| `statusCode` | integer | ✅ | HTTP response status code (0 for internal/trace events) |
| `latencyMs` | integer | ✅ | Round-trip latency in milliseconds |
| `model` | string | ❌ | LLM model name (only for `category=llm`) |
| `llmRequestId` | string | ❌ | Correlates one `llm` request with its `llm_message` and `tool_call` entries |
| `ttfbMs` | integer | ❌ | Time to first response header/body for LLM calls |
| `requestBytes` | integer | ❌ | LLM request body size observed by the proxy |
| `responseBytes` | integer | ❌ | LLM response body size observed by the proxy |
| `errorPreview` | string | ❌ | Redacted provider error preview for failed LLM responses |
| `messagesSent` | integer | ❌ | Number of request messages in the LLM request |
| `promptTokens` | integer | ❌ | Prompt/input tokens extracted from provider response |
| `completionTokens` | integer | ❌ | Completion/output tokens extracted from provider response |
| `totalTokens` | integer | ❌ | Total tokens extracted from provider response |
| `messageIndex` | integer | ❌ | Request message index (`-1` for top-level Anthropic-style `system`) |
| `messageRole` | string | ❌ | Request message role (`system`, `user`, `assistant`, `tool`, etc.) |
| `messageContentType` | string | ❌ | Request message content kind (`text`, `parts`, `object`, or `empty`) |
| `messagePreview` | string | ❌ | Redacted, truncated local preview of request message content |
| `messageChars` | integer | ❌ | Original message content character count before truncation |
| `messageName` | string | ❌ | Optional provider message name |
| `service` | string | ❌ | Integration service name (only for `category=integration`) |
| `framework` | string | ❌ | Agent framework name (e.g. `crewai`, `langgraph`) |
| `agent` | string | ❌ | Agent name/role within the framework |
| `toolName` | string | ❌ | Tool function name (for `category=tool_call`) |
| `toolCallId` | string | ❌ | Tool call ID from the LLM provider |
| `toolArgs` | string | ❌ | Tool arguments as JSON string |
| `traceEvent` | string | ❌ | Trace lifecycle event (for `category=trace`) |
| `traceResult` | string | ❌ | Result/output from a trace event |

---

## Entry Categories

| Category | Meaning | When Recorded |
|---|---|---|
| `llm` | Request to `llm.gateway` — forwarded to the LLM provider | Every LLM API call from the container |
| `llm_message` | Redacted preview of one message in an LLM request | Once per request message, before forwarding upstream |
| `egress` | Request to an external host allowed by policy | Every policy-allowed non-LLM request |
| `blocked` | Request denied by the policy engine | Every denied request (HTTP 403) |
| `integration` | Request to an integration gateway (e.g. `slack.gateway`) | Every integration API call |
| `tool_call` | LLM tool invocation extracted from the response | Each tool call in an LLM response |
| `trace` | Framework lifecycle event (agent start/end, task start/end, etc.) | When framework callbacks report events |

### Trace Event Types

Framework callbacks can emit the following event types:

| Event | Meaning |
|---|---|
| `tool_call` | A tool was invoked by the framework |
| `agent_start` | An agent began execution |
| `agent_end` | An agent finished execution |
| `task_start` | A task began execution |
| `task_end` | A task completed |
| `delegation` | An agent delegated work to another agent |
| `node_enter` | Entered a graph node (LangGraph) |
| `node_exit` | Exited a graph node (LangGraph) |
| `step` | A generic execution step |
| `error` | An error occurred |
| `custom` | Custom application-defined event |

### Special INTERNAL Events

| URL | Meaning |
|---|---|
| `session_start` | Proxy daemon started, new audit session began |
| `session_stop` | Proxy daemon shutting down |

These use `method: "INTERNAL"` and are filtered out from the formatted table view in `silo logs`.

---

## LLM Message Previews

`llm_message` entries make the audit trail useful for debugging agent behavior because they show the individual request messages that were sent to the LLM gateway instead of only the aggregate POST request.

To keep this local audit trail safer:

- Message previews are truncated to 240 characters by default.
- Common credentials such as OpenAI keys, Anthropic keys, Slack tokens, GitHub tokens, and bearer tokens are redacted before writing.
- Full request bodies are not stored by SILO.
- Preview length can be changed with `SILO_LOG_PREVIEW_CHARS`.

Examples:

```bash
# Hide message previews but keep role/index/size metadata
SILO_LOG_PREVIEW_CHARS=0 silo start

# Increase local previews for debugging
SILO_LOG_PREVIEW_CHARS=1000 silo start
```

The audit file is local to your host machine at `~/.silo/audit.jsonl`. Treat it as sensitive operational data if your agent prompts include private project context.

---

## Log Rotation

SILO automatically rotates the audit log to prevent unbounded disk usage.

### Rotation Scheme

```
audit.jsonl         ← currently active log
audit.1.jsonl       ← previous rotation
audit.2.jsonl       ← older
audit.3.jsonl       ← older
audit.4.jsonl       ← older
audit.5.jsonl       ← oldest (deleted when next rotation occurs)
```

### Configuration

| Setting | Default | Environment Variable |
|---|---|---|
| Rotation threshold | 10 MB | `SILO_LOG_MAX_BYTES` |
| Max rotated files | 5 | Hardcoded |

```bash
# Override rotation threshold (50 MB)
SILO_LOG_MAX_BYTES=52428800 silo start

# 100 MB threshold
SILO_LOG_MAX_BYTES=104857600 silo start
```

### Rotation Timing

Rotation is checked **before every log append**. If the current log exceeds the threshold:
1. Delete `audit.5.jsonl` if it exists
2. Rename `audit.4.jsonl` → `audit.5.jsonl`
3. Rename `audit.3.jsonl` → `audit.4.jsonl`
4. Rename `audit.2.jsonl` → `audit.3.jsonl`
5. Rename `audit.1.jsonl` → `audit.2.jsonl`
6. Rename `audit.jsonl` → `audit.1.jsonl`
7. New writes go to a fresh `audit.jsonl`

---

## Viewing Logs

### Formatted Table View

```bash
silo logs
```

```
Audit Log (20 entries)

┌──────────┬──────────┬────────┬───────────┬────────────────────────────┬────────┬─────────┬─────────────┐
│ Time     │ Category │ Verdict│ Method    │ Host                       │ Status │ Latency │ Detail      │
├──────────┼──────────┼────────┼───────────┼────────────────────────────┼────────┼─────────┼─────────────┤
│ 18:30:12 │ msg      │ allow  │ MSG       │ 3:user                     │ -      │ -       │ Open the…   │
│ 18:30:12 │ llm      │ allow  │ POST      │ llm.gateway                │ 200    │ 1423ms  │ crewai      │
│ 18:30:14 │ tool_call│ allow  │ TOOL_CALL │ llm.gateway                │ 200    │ 0ms     │ read_file   │
│ 18:30:15 │ trace    │ allow  │ TRACE     │ framework                  │ 0      │ 0ms     │ agent_start │
│ 18:31:02 │ egress   │ allow  │ GET       │ pypi.org                   │ 200    │ 156ms   │ —           │
│ 18:32:10 │ blocked  │ deny   │ POST      │ evil.example.com           │ 403    │ 2ms     │ —           │
└──────────┴──────────┴────────┴───────────┴────────────────────────────┴────────┴─────────┴─────────────┘

ℹ  Log file: ~/.silo/audit.jsonl
```

### Filtered Views

```bash
# Only LLM calls
silo logs --category llm

# Individual request messages sent to the LLM gateway
silo logs --category llm_message

# Only blocked requests
silo logs --verdict deny

# Only tool calls
silo logs --category tool_call

# Framework traces
silo logs --category trace
silo traces                         # Shortcut

# Filter by framework
silo logs --framework crewai

# Filter by agent
silo logs --agent Researcher

# Last hour
silo logs --since 1h

# Last 50 entries
silo logs --tail 50

# Combined filters
silo logs --category llm --since 2h --tail 10
silo logs --framework crewai --agent Writer --since 1h

# Only integration API calls
silo logs --category integration
```

### Live Tail (Follow Mode)

```bash
# Follow the audit log in real-time (like tail -f)
silo logs --follow
silo logs -F              # Short form

# Follow with filters — only show blocked requests as they happen
silo logs --follow --verdict deny

# Follow only LLM calls in real-time
silo logs --follow --category llm

# Follow in JSON format
silo logs --follow --json
```

Live tail uses `fs.watch()` to monitor the audit log file for changes and prints new entries as they arrive. All existing filters (`--category`, `--verdict`, `--framework`, `--agent`) are applied to each new entry in real-time.

Press **Ctrl+C** to stop following.

> **Tip:** Run `silo logs --follow` in one terminal while running `silo run` in another to watch every LLM call, tool use, and egress request live.

### Raw JSON Output

```bash
# Raw JSONL for piping
silo logs --json

# Filtered JSONL
silo logs --json --category blocked
```

---

## Forensic Analysis

### Basic Queries

```bash
# Which hosts were accessed?
silo logs --json | jq -r '.host' | sort | uniq -c | sort -rn

# Were any requests blocked?
silo logs --verdict deny

# How many LLM calls?
silo logs --json --category llm | wc -l

# What tools did the agent use?
silo logs --json --category tool_call | jq -r '.toolName' | sort | uniq -c | sort -rn

# Which agents were active?
silo logs --json --category trace | jq -r 'select(.agent) | .agent' | sort -u
```

### Performance Analysis

```bash
# Average LLM response latency
silo logs --json --category llm | jq '.latencyMs' | awk '{sum+=$1; n++} END {print "Average: " sum/n "ms"}'

# Slowest LLM calls
silo logs --json --category llm | jq -r '[.timestamp, .latencyMs, .model] | @tsv' | sort -t$'\t' -k2 -rn | head -5
```
```

### Security Forensics

```bash
# All unique hosts the agent tried to reach
silo logs --json | jq -r '.host' | sort -u

# Timeline of blocked requests
silo logs --json --verdict deny | jq -r '[.timestamp, .method, .host, .url] | @tsv'

# Were any CONNECT tunnels blocked?
silo logs --json | jq 'select(.method == "CONNECT")'

# Export full audit for external analysis
silo logs --json > full-audit-$(date +%Y%m%d).jsonl

# Which integration APIs did the agent call?
silo logs --json --category integration | jq -r '.service' | sort | uniq -c | sort -rn

# Integration API call timeline
silo logs --json --category integration | jq -r '[.timestamp, .service, .method, .url, .statusCode] | @tsv'
```

### CSV Export

```bash
# Export LLM calls as CSV
silo logs --json --category llm | jq -r '[.timestamp, .model, .latencyMs, .statusCode] | @csv' > llm-calls.csv

# Export tool calls as CSV
silo logs --json --category tool_call | jq -r '[.timestamp, .toolName, .framework, .agent] | @csv' > tool-calls.csv

# Export all entries as CSV
silo logs --json | jq -r '[.timestamp, .category, .verdict, .method, .host, .statusCode, .latencyMs] | @csv' > audit.csv
```

---

## Interceptor Decision Log

Separate from the main audit trail, interceptor decisions are logged to:

**Path:** `~/.silo/blocked-requests.jsonl`

```json
{
  "timestamp": "2026-04-11T18:32:10.789Z",
  "method": "POST",
  "host": "evil.example.com",
  "url": "http://evil.example.com/exfiltrate",
  "decision": "deny"
}
```

The `decision` field can be: `pending`, `allow_once`, `allow_always`, or `deny`.

---

## Session Management

### Session IDs

Each proxy daemon start creates a new audit session with a unique UUID. This allows filtering entries by session:

```bash
# View current session ID
silo status  # Shows in the Audit section

# Filter by session
silo logs --json | jq 'select(.sessionId == "a3f1b2c...")'
```

### Session Events

The proxy logs session lifecycle events:
- `session_start` — recorded when the proxy daemon starts
- `session_stop` — recorded when the proxy daemon receives SIGTERM/SIGINT

---

## File Locations

| File | Path | Purpose |
|---|---|---|
| Active audit log | `~/.silo/audit.jsonl` | Current audit trail |
| Rotated logs | `~/.silo/audit.{1-5}.jsonl` | Previous rotations |
| Blocked requests | `~/.silo/blocked-requests.jsonl` | Interceptor decisions |
| PID file | `~/.silo/proxy.pid` | Proxy daemon process ID |

---

## Programmatic Access

The audit module exports functions for programmatic access:

```typescript
import { readAuditLog, auditLogPath } from "./audit/audit.js";

// Read with filters
const entries = await readAuditLog({
  tail: 50,
  category: "llm",
  verdict: "allow",
  since: new Date("2026-04-10"),
  sessionId: "abc-123",
});

// Get log path
const path = auditLogPath(); // ~/.silo/audit.jsonl
```

---

*SILO v0.2.0 — Secure AI Agent Sandbox Orchestrator*
