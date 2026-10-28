# Configuration

> Config schema, storage locations, environment variables, and runtime customisation.

---

## Config Storage

SILO uses the [`conf`](https://github.com/sindresorhus/conf) package for persistent configuration, which stores data in OS-native preference directories:

| Platform | Path |
|---|---|
| **macOS** | `~/Library/Preferences/cli-silo-nodejs/config.json` |
| **Linux** | `~/.config/cli-silo-nodejs/config.json` |

The config file is a JSON document validated by Zod schemas on every read and write. **Secrets (API keys and integration tokens) are encrypted at rest** using AES-256-GCM — see [Encryption at Rest](#encryption-at-rest) below.

---

## Config Schema

The complete configuration is defined in `src/config/schema.ts`:

### Top-Level `SiloConfig`

```typescript
{
  version: "1",              // Schema version for forward-compatibility
  llm: LLMConfig,            // LLM provider settings
  sandbox: SandboxConfig,    // Docker sandbox settings
  proxy: ProxyConfig,        // Inference proxy settings
  integrations: IntegrationConfig[],  // Credential-managed API integrations
  onboardedAt?: string       // ISO-8601 timestamp of last successful onboard
}
```

### `LLMConfig`

```typescript
{
  provider: "openai" | "anthropic" | "local",
  apiKey: string,            // Encrypted at rest (AES-256-GCM), decrypted transparently on read
  model: string,             // e.g. "gpt-4o", "claude-sonnet-4-6", "llama3"
  baseUrl?: string           // URL override for local/custom providers
}
```

### `SandboxConfig`

```typescript
{
  image: string,             // Docker image tag (default: "silo-sandbox:latest")
  containerName: string,     // Container name (default: "silo-agent")
  workspacePath: string,     // Host path mounted as /workspace
  cpuLimit: string,          // CPU limit (e.g. "1.0")
  memoryLimit: string,       // Memory limit (e.g. "512m")
  policyFile?: string        // Path to active YAML policy file
}
```

### `ProxyConfig`

```typescript
{
  port: number,              // Port the proxy listens on (default: 8199, range: 1024-65535)
  running: boolean           // Whether the proxy is currently running
}
```

### `IntegrationConfig`

```typescript
{
  name: string,              // Lowercase identifier (e.g. "slack", "github")
  baseUrl: string,           // Upstream API URL (e.g. "https://slack.com/api")
  gateway: string,           // Gateway alias (e.g. "slack.gateway")
  authType: "bearer" | "header" | "query",  // Authentication method
  token: string,             // Encrypted at rest (AES-256-GCM), decrypted transparently on read
  authHeader?: string,       // Custom header name (for authType "header")
  authQueryParam?: string,   // Query param name (for authType "query")
  extraHeaders?: Record<string, string>,  // Additional headers (e.g. API version)
  description?: string       // Human-readable description
}
```

**Auth types:**

| Type | What the proxy injects |
|---|---|
| `bearer` | `Authorization: Bearer <token>` |
| `header` | `<authHeader>: <token>` (default header: `x-api-key`) |
| `query` | `?<authQueryParam>=<token>` appended to URL |

See [`docs/integrations.md`](./integrations.md) for the full integration guide.

---

## Config Operations

### Reading Config

```typescript
import { readConfig } from "./config/manager.js";

const config = readConfig();
// Returns SiloConfig | null (null if not onboarded yet)
```

Returns `null` if no config exists. Throws if the config file exists but is corrupted or fails Zod validation.

### Writing Config

```typescript
import { writeConfig } from "./config/manager.js";

writeConfig(config);  // Full Zod validation before persisting
```

### Patching Config

```typescript
import { patchConfig } from "./config/manager.js";

patchConfig({ proxy: { port: 8199, running: true } });
// Deep-merges into existing config
```

### Clearing Config

```typescript
import { clearConfig } from "./config/manager.js";

clearConfig();  // Wipes the entire config file
```

### Config Path

```typescript
import { configPath } from "./config/manager.js";

const path = configPath();  // Returns the filesystem path
```

---

## Encryption at Rest

All sensitive fields (`llm.apiKey` and each integration's `token`) are encrypted before writing to disk and decrypted transparently on read.

### How It Works

| Step | Detail |
|---|---|
| **Algorithm** | AES-256-GCM (authenticated encryption) |
| **Key derivation** | PBKDF2 with 100,000 iterations |
| **Key material** | `hostname` + `homedir` (machine-bound) |
| **IV** | Random 16 bytes per encryption (prevents ciphertext reuse) |
| **Format** | `enc:v1:<iv>:<authTag>:<ciphertext>` (all hex-encoded) |

### Implications

- **Non-portable:** The config file cannot be decrypted on a different machine (different hostname/homedir = different key)
- **Transparent migration:** Existing plaintext configs are automatically encrypted on the next `writeConfig()` call
- **Tamper detection:** AES-GCM auth tag verification fails if the ciphertext is modified
- **No double-encryption:** `ensureEncrypted()` detects the `enc:v1:` prefix and skips already-encrypted values

### API

```typescript
import { encryptSecret, decryptSecret, isEncrypted, ensureEncrypted, ensureDecrypted } from "./config/encryption.js";

// Low-level
const encrypted = encryptSecret("sk-abc123");   // → "enc:v1:a1b2...:c3d4...:e5f6..."
const plain = decryptSecret(encrypted);          // → "sk-abc123"

// Idempotent helpers (used by config manager)
ensureEncrypted("sk-abc123");      // → encrypts
ensureEncrypted("enc:v1:...");     // → returns as-is (already encrypted)
ensureDecrypted("enc:v1:...");     // → decrypts
ensureDecrypted("sk-abc123");      // → returns as-is (plaintext passthrough)
```

---

## Provider Configuration

### OpenAI

| Field | Value | Example |
|---|---|---|
| `provider` | `"openai"` | — |
| `apiKey` | OpenAI API key | `sk-proj-abc123...` |
| `model` | Any OpenAI model | `gpt-4o`, `gpt-4o-mini`, `gpt-4-turbo`, `o1`, `o3-mini` |
| `baseUrl` | (optional) Custom endpoint | `https://proxy.example.com` |

### Anthropic

| Field | Value | Example |
|---|---|---|
| `provider` | `"anthropic"` | — |
| `apiKey` | Anthropic API key | `sk-ant-abc123...` |
| `model` | Any Anthropic model | `claude-sonnet-4-6`, `claude-opus-4-6`, `claude-haiku` |
| `baseUrl` | (optional) Custom endpoint | `https://proxy.example.com` |

### Local / Custom

| Field | Value | Example |
|---|---|---|
| `provider` | `"local"` | — |
| `apiKey` | Any string (use `"local"` to skip auth) | `local`, `my-api-key` |
| `model` | Provider-dependent | `llama3`, `mistral`, `codellama` |
| `baseUrl` | Server URL | `http://localhost:11434`, `http://192.168.1.5:8080` |

---

## Environment Variables

| Variable | Description | Used By | Default |
|---|---|---|---|
| `SILO_DEBUG=1` | Enable verbose debug logging throughout all commands | All commands | Off |
| `SILO_LOG_MAX_BYTES` | Audit log rotation threshold in bytes | Proxy daemon | `10485760` (10MB) |
| `SILO_SANDBOX=1` | Set **inside** the container to indicate SILO sandbox mode | Container processes | `1` |
| `http_proxy` | Inference proxy URL | Container HTTP clients | `http://llm.gateway:<port>` |
| `https_proxy` | Same as `http_proxy` | Container HTTP clients | `http://llm.gateway:<port>` |
| `HTTP_PROXY` | Same (uppercase variant) | Container HTTP clients | Same |
| `HTTPS_PROXY` | Same (uppercase variant) | Container HTTP clients | Same |
| `no_proxy` | Bypass proxy for these hosts | Container HTTP clients | `localhost,127.0.0.1,::1` |
| `NO_PROXY` | Same (uppercase variant) | Container HTTP clients | Same |

### Debug Mode

```bash
# Enable debug logging
SILO_DEBUG=1 silo start
SILO_DEBUG=1 silo status
SILO_DEBUG=1 silo run "test task"
```

Debug output includes:
- Docker command arguments
- Proxy request routing decisions
- Policy evaluation details
- Upstream response status codes

### Custom Log Rotation

```bash
# 50 MB rotation threshold
SILO_LOG_MAX_BYTES=52428800 silo start

# 100 MB rotation threshold
SILO_LOG_MAX_BYTES=104857600 silo start

# 1 MB rotation threshold (for testing)
SILO_LOG_MAX_BYTES=1048576 silo start
```

---

## File Locations Summary

| File | Path | Purpose |
|---|---|---|
| **Config** | `~/Library/Preferences/cli-silo-nodejs/config.json` (macOS) | SILO configuration |
| **Config** | `~/.config/cli-silo-nodejs/config.json` (Linux) | SILO configuration |
| **Audit log** | `~/.silo/audit.jsonl` | Request audit trail |
| **Rotated logs** | `~/.silo/audit.{1-5}.jsonl` | Rotated audit logs |
| **Blocked log** | `~/.silo/blocked-requests.jsonl` | Interceptor decisions |
| **PID file** | `~/.silo/proxy.pid` | Proxy daemon PID |
| **Policies** | `./policies/*.yaml` | Policy preset files |
| **Active policy** | `~/.silo/policy.yaml` | Generated by `silo policy apply/add` |
| **Dockerfile** | `./sandbox/Dockerfile` | Sandbox image definition |
| **Entrypoint** | `./sandbox/entrypoint.sh` | Container PID 1 script |

---

## Schema Versioning

The config schema includes a `version` field (currently `"1"`) for forward-compatibility:

```json
{
  "version": "1",
  "llm": { ... },
  "sandbox": { ... },
  "proxy": { ... }
}
```

When the schema changes in future versions, the version field allows migration paths to automatically upgrade older config files.

---

## Example Config File

```json
{
  "version": "1",
  "llm": {
    "provider": "openai",
    "apiKey": "enc:v1:a1b2c3d4e5f6a7b8:1234abcd5678efgh:9a8b7c6d5e4f3a2b1c0d",
    "model": "gpt-4o"
  },
  "sandbox": {
    "image": "silo-sandbox:latest",
    "containerName": "silo-agent",
    "workspacePath": "/Users/user/silo-workspace",
    "cpuLimit": "1.0",
    "memoryLimit": "512m",
    "policyFile": "/Users/user/.silo/policy.yaml"
  },
  "proxy": {
    "port": 8199,
    "running": true
  },
  "integrations": [
    {
      "name": "slack",
      "baseUrl": "https://slack.com/api",
      "gateway": "slack.gateway",
      "authType": "bearer",
      "token": "enc:v1:b2c3d4e5f6a7b8c9:2345bcde6789fghi:0a1b2c3d4e5f6a7b8c9d"
    },
    {
      "name": "github",
      "baseUrl": "https://api.github.com",
      "gateway": "github.gateway",
      "authType": "bearer",
      "token": "enc:v1:c3d4e5f6a7b8c9d0:3456cdef789aghij:1a2b3c4d5e6f7a8b9c0d",
      "extraHeaders": {
        "accept": "application/vnd.github+json",
        "x-github-api-version": "2022-11-28"
      }
    }
  ],
  "onboardedAt": "2026-04-11T18:00:00.000Z"
}
```

> **Note:** The `apiKey` and `token` fields shown above are encrypted at rest. When read via `readConfig()`, they are transparently decrypted to their plaintext values. Existing plaintext configs will be automatically encrypted on the next write.

---

*SILO v0.2.0 — Secure AI Agent Sandbox Orchestrator*
