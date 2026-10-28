# Policy Engine

> Complete reference for SILO's YAML-based egress policy system.

---

## Overview

The policy engine controls which outbound network hosts the sandboxed agent can reach. It uses declarative YAML files with glob pattern matching, evaluated on every request through the proxy. During `silo onboard`, you choose between **Strict** (default deny — blocks unknown traffic, prompts for approval) and **Audit Only** (default allow — permits all traffic but logs everything). Both modes produce a `~/.silo/policy.yaml` file that you can customise at any time.

---

## Policy File Format

```yaml
version: "1"                      # Schema version (required)
name: "my-custom-policy"          # Human-readable name (required)
description: "Optional description"  # (optional)
default: deny                     # Default action when no rule matches: "deny" or "allow" (required)

rules:                            # Ordered list of host rules (required, may be empty)
  - host: "llm.gateway"          # Host pattern (glob or exact match)
    action: allow                 # "allow" or "deny"
    comment: "LLM inference proxy"  # Optional description

  - host: "pypi.org"
    action: allow

  - host: "*.pythonhosted.org"   # Wildcard patterns supported
    action: allow

  - host: "evil.example.com"
    action: deny
    comment: "Known bad host"
```

### Schema Validation

Policy files are validated at load time using Zod schemas. The following fields are required:

| Field | Type | Required | Description |
|---|---|---|---|
| `version` | string | ✅ | Schema version (currently `"1"`) |
| `name` | string | ✅ | Human-readable policy name |
| `description` | string | ❌ | Optional description |
| `default` | `"allow"` \| `"deny"` | ✅ | Action when no rule matches |
| `rules` | array | ✅ | Ordered list of rules (may be empty) |

Each rule has:

| Field | Type | Required | Description |
|---|---|---|---|
| `host` | string | ✅ | Host pattern (exact or glob) |
| `action` | `"allow"` \| `"deny"` | ✅ | What to do when this rule matches |
| `comment` | string | ❌ | Optional description |

---

## Evaluation Semantics

### Algorithm

```
for each rule in policy.rules (top to bottom):
    if glob_match(rule.host, request_host):
        return rule.action     # first match wins

return policy.default          # fallback when no rule matches
```

### Key Properties

1. **First match wins** — rules are evaluated in declaration order
2. **Case-insensitive** — `PyPI.ORG` matches `pypi.org`
3. **No regex** — uses glob patterns (picomatch), not regular expressions
4. **Port-independent** — only the hostname is matched, not the port

---

## Glob Patterns

SILO uses [picomatch](https://github.com/micromatch/picomatch) for pattern matching. The following glob features are available:

| Pattern | Matches | Example |
|---|---|---|
| `*` | Any character except `/` | `*.pypi.org` matches `cdn.pypi.org`, `a.b.pypi.org` |
| `**` | Any character including `.` | `**.example.com` matches `deep.sub.example.com` |
| `{a,b}` | Brace expansion | `{pypi,npmjs}.org` matches both `pypi.org` and `npmjs.org` |
| `[a-z]` | Character class | `host[0-9].example.com` matches `host3.example.com` |
| Exact | Literal match | `api.github.com` matches only `api.github.com` |

> **Note:** Since hostnames never contain `/`, the `*` pattern effectively matches any characters, including dots. This means `*.pythonhosted.org` matches both `files.pythonhosted.org` and `cdn.files.pythonhosted.org`. This is intentionally permissive for allow-list rules.

---

## Built-in Presets

SILO includes four built-in policy presets that can be merged into the active policy:

### `pypi`

Allow Python package installation via pip.

```yaml
rules:
  - host: "pypi.org"                action: allow   # Package index
  - host: "files.pythonhosted.org"  action: allow   # Wheel/sdist downloads
  - host: "*.pythonhosted.org"      action: allow   # CDN shards
```

### `npm`

Allow Node.js package installation via npm/pnpm/yarn.

```yaml
rules:
  - host: "registry.npmjs.org"   action: allow   # Package registry
  - host: "*.npmjs.org"          action: allow   # CDN
```

### `github`

Allow Git clone, GitHub REST API, and raw file access.

```yaml
rules:
  - host: "github.com"                    action: allow
  - host: "api.github.com"                action: allow   # REST API
  - host: "raw.githubusercontent.com"     action: allow   # Raw files
  - host: "objects.githubusercontent.com"  action: allow   # Git objects
```

### `huggingface`

Allow downloading models and datasets from Hugging Face Hub.

```yaml
rules:
  - host: "huggingface.co"          action: allow   # Hub
  - host: "cdn-lfs.huggingface.co"  action: allow   # LFS storage
  - host: "*.hf.co"                 action: allow   # CDN
```

---

## Preset Management

### Listing Presets

```bash
silo policy list
```

Displays all available presets with their names, descriptions, and allowed hosts.

### Applying a Preset

```bash
silo policy apply pypi
```

**Behaviour:**
1. If no policy file exists, creates a new one at `~/.silo/policy.yaml` (using the mode chosen during onboard, or deny-all if run manually)
2. Appends the preset's rules to the existing policy
3. Skips rules where the host pattern already exists (idempotent)
4. Persists the policy file path in config if not already set
5. Sends `SIGHUP` to the proxy daemon for hot-reload

### Removing a Preset

```bash
silo policy remove pypi
```

**Behaviour:**
1. Reads the existing policy file
2. Removes all rules whose host patterns match the preset's rules
3. Writes the updated policy back to disk
4. Sends `SIGHUP` to the proxy for hot-reload

### Adding Individual Rules

```bash
# Allow a host (default action)
silo policy add api.github.com

# Block a host
silo policy add "*.malware.com" --action deny

# With a comment
silo policy add pypi.org --comment "PyPI package index"
```

**Behaviour:**
1. If no policy file exists, bootstraps one from the baseline (using the mode chosen during onboard)
2. Checks for duplicate host patterns (skips if already present)
3. Appends the new rule to the rules list
4. Writes the updated policy and hot-reloads the proxy

---

## Hot-Reload

The proxy daemon supports hot-reloading policy from disk without restarting:

### Via CLI Command

```bash
silo policy reload
```

This sends `SIGHUP` to the proxy daemon process (located via the PID file at `~/.silo/proxy.pid`).

### Via Manual Signal

```bash
kill -HUP $(cat ~/.silo/proxy.pid)
```

### Automatic on Preset Changes

When using `silo policy apply`, `silo policy remove`, or `silo policy add`, the proxy is automatically reloaded if it's running.

### File Watcher (Removed)

Direct filesystem watching via filesystem events (e.g. `watchPolicyFile()`) has been removed to ensure reliability and simplify state tracking. Hot-reloading is fully supported via the `SIGHUP` signal (e.g. using `silo policy reload`), or programmatically when rules are written dynamically via the interceptor.

---

## Policy File Locations

| File | Location | Purpose |
|---|---|---|
| Built-in default | `policies/default.yaml` | Deny-all baseline (shipped with SILO) |
| PyPI preset | `policies/pypi.yaml` | Python package installs |
| npm preset | `policies/npm.yaml` | Node.js package installs |
| Active policy | `~/.silo/policy.yaml` | Generated by `silo policy apply/add` |
| Custom policy | Any path | Specified via `silo start --policy <path>` |

---

## Compilation & Performance

For the proxy hot path (evaluated on every request), policies can be pre-compiled:

```typescript
import { compilePolicy, evaluateCompiled } from "./policy/engine.js";

const compiled = compilePolicy(policy);  // Create picomatch matchers once
const verdict = evaluateCompiled(compiled, "pypi.org");  // O(n) evaluation per request
```

The convenience `evaluate(policy, host)` function compiles and evaluates in one step, which is suitable for infrequent calls (e.g., `silo policy show`).

---

## Writing Custom Policies

### Example: Data Science Agent

```yaml
version: "1"
name: "data-science"
description: "Policy for a data-science agent that needs PyPI and Hugging Face"
default: deny

rules:
  # Required — LLM proxy
  - host: "llm.gateway"
    action: allow
    comment: "SILO inference proxy"

  # Python packages
  - host: "pypi.org"
    action: allow
  - host: "files.pythonhosted.org"
    action: allow
  - host: "*.pythonhosted.org"
    action: allow

  # Hugging Face models
  - host: "huggingface.co"
    action: allow
  - host: "cdn-lfs.huggingface.co"
    action: allow

  # Internal APIs
  - host: "api.internal.company.com"
    action: allow
    comment: "Internal data API"

  # Explicitly block known-bad hosts
  - host: "*.malware.com"
    action: deny
    comment: "Known malicious domain"
```

### Example: Strict Audit (LLM Only)

```yaml
version: "1"
name: "llm-only"
description: "Only allows LLM calls — everything else is intercepted"
default: deny

rules:
  - host: "llm.gateway"
    action: allow
    comment: "LLM inference only"
```

### Example: Audit Only (Default Allow)

This is what `silo onboard` generates when you choose **Audit Only** mode. All traffic is allowed and fully logged — ideal for understanding what an agent actually needs before locking down.

```yaml
version: "1"
name: "audit-only"
description: "Audit-only — all traffic is allowed and logged for review"
default: allow

rules:
  - host: "llm.gateway"
    action: allow
    comment: "SILO inference proxy"
```

> Host loopback (`localhost`, `127.0.0.0/8`, `::1`, `0.0.0.0`) is never reachable through the proxy, even under `default: allow` or an explicit allow rule. The proxy runs on the host, so those addresses would reach the host's own services. Names that resolve to loopback via DNS are refused too.

### Example: Open Policy with Blocklist

```yaml
version: "1"
name: "open-with-blocklist"
description: "Allow most traffic, block known-bad hosts"
default: allow

rules:
  - host: "*.malware.com"
    action: deny
  - host: "pastebin.com"
    action: deny
    comment: "Prevent data exfiltration"
  - host: "webhook.site"
    action: deny
    comment: "Prevent data exfiltration"
```

---

## Interaction with the Interceptor

When a request matches a `deny` verdict:

1. **TTY mode** (interactive terminal): The interceptor prompts the user
   - Allow once → request proceeds, logged
   - Allow always → host added to policy, request proceeds, logged
   - Deny → HTTP 403 returned, logged

2. **Non-TTY mode** (daemon, CI): If a foreground Prompt Listener (from `silo run` or `silo connect`) is active and polling, the request is queued for up to 30 seconds to allow interactive resolution in the calling terminal via REST endpoints. If no listener is active, or the prompt times out, the request is automatically denied and logged.

All interceptor decisions are persisted in `~/.silo/blocked-requests.jsonl` for forensic review.

---

*SILO v0.2.0 — Secure AI Agent Sandbox Orchestrator*
