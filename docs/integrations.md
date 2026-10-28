# Integrations

SILO's integration system lets sandboxed agents call external productivity APIs — Slack, GitHub, HubSpot, and more — **without ever seeing the real API credentials**. It extends the same credential-isolation pattern used for LLM providers to any REST API.

---

## How It Works

Each integration gets a **gateway alias** (e.g. `slack.gateway`) that maps to the host machine where the inference proxy runs. When the agent makes a request to `http://slack.gateway:8199/chat.postMessage`, the proxy:

1. **Intercepts** the request
2. **Strips** any auth headers the container might have sent
3. **Injects** the real API token from host-side config
4. **Forwards** to the real API (`https://slack.com/api/chat.postMessage`)
5. **Logs** the request in the audit trail with `category: "integration"`

The agent never sees the real token. It's the same security model as LLM credential isolation, extended to arbitrary APIs.

```
Agent → http://slack.gateway:8199/chat.postMessage
                    ↓
         Proxy injects Bearer xoxb-...
                    ↓
         https://slack.com/api/chat.postMessage
```

---

## Quick Start

### 1. Add an integration

```bash
# Use a built-in template (Slack, GitHub, HubSpot, Linear, Notion)
silo integrations add slack
# → Prompts only for your Slack Bot Token

# Or set up a custom integration
silo integrations add my-api
# → Prompts for base URL, auth type, token, etc.
```

### 2. Restart your sandbox

```bash
silo stop && silo start
```

The new gateway alias is registered as a Docker `--add-host` entry, so the container needs to be recreated.

This works the same in default and `--browser` framework runs. Browser mode adds Chromium and browser tmpfs mounts, but integration gateway aliases such as `slack.gateway` and `github.gateway` still route through the host proxy and never expose tokens inside the sandbox.

### 3. Use it from inside the sandbox

```bash
# Inside the sandbox — no credentials needed:
curl http://slack.gateway:8199/chat.postMessage \
  -H "Content-Type: application/json" \
  -d '{"channel":"#general","text":"Hello from SILO agent!"}'
```

The proxy injects your real Slack token automatically.

---

## CLI Commands

| Command | Description |
|---|---|
| `silo integrations add <service>` | Add a new integration (interactive wizard) |
| `silo integrations list` | List all configured integrations |
| `silo integrations remove <name>` | Remove an integration |
| `silo integrations test <name>` | Test connectivity to the API endpoint |
| `silo integrations templates` | Show available built-in templates |

Alias: `silo int` (e.g. `silo int add slack`, `silo int list`)

---

## Built-in Templates

Templates pre-fill everything except the API token, so setup takes seconds:

| Template | Service | Base URL | Auth | Token Format |
|---|---|---|---|---|
| `slack` | Slack | `https://slack.com/api` | Bearer | `xoxb-...` |
| `github` | GitHub | `https://api.github.com` | Bearer | `ghp_...` or `github_pat_...` |
| `hubspot` | HubSpot | `https://api.hubapi.com` | Bearer | `pat-...` |
| `linear` | Linear | `https://api.linear.app` | Bearer | `lin_api_...` |
| `notion` | Notion | `https://api.notion.com` | Bearer | `secret_...` |

Templates with extra headers (e.g. GitHub's `x-github-api-version`, Notion's `notion-version`) inject those automatically on every request.

---

## Custom Integrations

For APIs without a built-in template, the wizard prompts for all fields:

```bash
silo integrations add jira
```

You'll be asked for:
- **Base URL** — e.g. `https://your-domain.atlassian.net/rest/api/3`
- **Auth type** — Bearer token, custom header, or query parameter
- **Token** — your API key or token

### Supported Auth Types

| Type | How It Works | Example |
|---|---|---|
| `bearer` | `Authorization: Bearer <token>` | Slack, GitHub, HubSpot |
| `header` | `<header-name>: <token>` | APIs using `x-api-key`, `hapikey`, etc. |
| `query` | `?<param>=<token>` appended to URL | Legacy APIs with query-string auth |

---

## Security Model

Integration credentials follow the same isolation principles as LLM API keys:

| Property | How |
|---|---|
| **Never in the container** | Tokens are stored in host-side config (`~/.config/cli-silo`) |
| **Stripped on ingress** | Auth headers from the container are removed before forwarding |
| **Injected at proxy time** | Real tokens are added by the proxy just before forwarding upstream |
| **Fully audited** | Every integration API call is logged with `category: "integration"` |
| **Policy controlled** | Integration gateways are allowed by default; other hosts follow the policy engine |

---

## Audit Logging

Integration API calls appear in the audit trail with category `integration`:

```bash
silo logs --category integration
```

```
┌──────────┬──────────┬────────┬────────┬─────────────────────┬────────┬─────────┬──────────┐
│ Time     │ Category │ Verdict│ Method │ Host                │ Status │ Latency │ Tokens   │
├──────────┼──────────┼────────┼────────┼─────────────────────┼────────┼─────────┼──────────┤
│ 14:30:12 │ integ    │ allow  │ POST   │ slack.gateway       │ 200    │ 342ms   │ —        │
│ 14:31:02 │ integ    │ allow  │ GET    │ github.gateway      │ 200    │ 189ms   │ —        │
│ 14:32:10 │ integ    │ allow  │ POST   │ hubspot.gateway     │ 201    │ 456ms   │ —        │
└──────────┴──────────┴────────┴────────┴─────────────────────┴────────┴─────────┴──────────┘
```

JSON output includes the `service` field:

```bash
silo logs --category integration --json | jq '{service: .service, method: .method, status: .statusCode}'
```

---

## Status Dashboard

`silo status` shows all configured integrations:

```
Integrations
┌───────────┬──────────────────┬──────────────────────────────┬─────────┐
│ Name      │ Gateway          │ Base URL                     │ Auth    │
├───────────┼──────────────────┼──────────────────────────────┼─────────┤
│ slack     │ slack.gateway    │ https://slack.com/api         │ bearer  │
│ github    │ github.gateway   │ https://api.github.com        │ bearer  │
└───────────┴──────────────────┴──────────────────────────────┴─────────┘
```

---

## Example: Slack Bot Agent

```bash
# Setup
silo onboard                          # Configure LLM
silo integrations add slack           # Enter your Slack Bot Token
silo build && silo start

# Run the agent
silo run "Post a summary of today's git commits to #engineering on Slack"

# The agent will:
# 1. Run `git log` in the sandbox
# 2. Call the LLM to summarize
# 3. POST to http://slack.gateway:8199/chat.postMessage
#    → Proxy injects the real token and forwards to Slack

# Review what happened
silo logs --category integration
silo stop
```

---

## Example: GitHub PR Review Agent

```bash
silo integrations add github          # Enter your GitHub PAT
silo stop && silo start

silo run "List open PRs in owner/repo and summarize each one"

# The agent calls http://github.gateway:8199/repos/owner/repo/pulls
# → Proxy injects the PAT and GitHub API version header
# → Full audit trail of every GitHub API call
```

---

## Managing Integrations

```bash
# List all configured integrations
silo integrations list

# Remove an integration
silo integrations remove slack

# Test connectivity (makes a simple HTTPS request to the base URL)
silo integrations test github

# See available templates
silo integrations templates
```

---

*SILO v0.2.0 — Secure AI Agent Sandbox Orchestrator*
