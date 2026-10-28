# Development Guide

> Setting up the development environment, running tests, building, and contributing.

---

## Prerequisites

| Tool | Minimum Version | Purpose |
|---|---|---|
| Node.js | 18.0.0+ | Runtime |
| npm | 8+ | Package management |
| Docker | 20.10+ | Container runtime (for integration testing) |
| Git | 2.x | Version control |

---

## Setup

```bash
# Clone the repo
git clone https://github.com/AsDivyansh/silo.git
cd silo

# Install dependencies
npm install

# Verify the setup
npm run dev -- --help
```

---

## Development Mode

During development, use `npm run dev` to run SILO directly from TypeScript source without a build step. This uses `tsx` for live TypeScript execution:

```bash
# Run any SILO command
npm run dev -- onboard
npm run dev -- start
npm run dev -- run "test task"
npm run dev -- status

# With debug logging
SILO_DEBUG=1 npm run dev -- start
```

---

## Project Structure

```
src/
├── cli.ts                     # Entry point (Commander.js setup)
├── commands/                  # CLI command implementations
│   ├── onboard.ts             # Interactive setup wizard
│   ├── quickstart.ts          # Zero-to-sandbox one-command flow
│   ├── build.ts               # Docker image builder
│   ├── start.ts               # Stack launcher
│   ├── stop.ts                # Stack teardown
│   ├── connect.ts             # Shell into sandbox
│   ├── run.ts                 # Agent task runner (proxy-routed, 3 tools)
│   ├── list.ts                # List agents
│   ├── status.ts              # Health dashboard
│   ├── doctor.ts              # System diagnostic checks
│   ├── policy.ts              # Policy management subcommands
│   ├── logs.ts                # Audit log viewer (incl. --follow live tail)
│   ├── traces.ts              # Framework trace viewer
│   ├── frameworks.ts          # Framework list/info subcommands
│   ├── integrations.ts        # Integration management (add/list/remove/test)
│   └── snapshot.ts            # Container snapshot
├── proxy/
│   ├── server.ts              # HTTP proxy server (pre-compiled policy)
│   ├── daemon.ts              # Detached daemon entry
│   ├── provider.ts            # LLM routing + auth injection
│   ├── interceptor.ts         # TUI approve/deny + allow_always persistence
│   └── spawn.ts               # Shared daemon spawner (DRY helper)
├── policy/
│   ├── engine.ts              # YAML policy evaluator (CompiledPolicy)
│   └── presets.ts             # Built-in presets
├── audit/
│   ├── audit.ts               # JSONL audit logger + log rotation
│   ├── tool-calls.ts          # Tool call extraction from LLM responses
│   └── traces.ts              # Framework trace ingestion
├── docker/
│   ├── runner.ts              # Container lifecycle
│   └── templates.ts           # Security-hardened run flags
├── config/
│   ├── schema.ts              # Zod schemas
│   ├── manager.ts             # Config read/write/patch (with encryption)
│   └── encryption.ts          # AES-256-GCM credential encryption at rest
├── frameworks/
│   ├── definitions.ts         # Framework metadata
│   ├── registry.ts            # Framework registry
│   ├── docker-builder.ts      # Framework-aware image builder
│   └── lifecycle.ts           # Framework startup hooks
├── integrations/
│   ├── resolver.ts            # Integration routing + auth injection
│   └── templates.ts           # Built-in integration templates
└── utils/
    ├── logger.ts              # Branded CLI output
    ├── health.ts              # Proxy health + auto-restart
    ├── pid.ts                 # PID file management
    ├── prompt-listener.ts     # Foreground prompt polling loop (IPC)
    └── system.ts              # Docker/Node version checks
```

---

## Build System

SILO uses [tsup](https://tsup.egoist.dev/) to bundle two separate entry points:

### Building

```bash
npm run build
```

**Output:**

| Input | Output | Purpose |
|---|---|---|
| `src/cli.ts` | `dist/cli.js` | CLI binary (with `#!/usr/bin/env node` shebang) |
| `src/proxy/daemon.ts` | `dist/proxy-daemon.js` | Standalone daemon (no shebang) |

Both outputs are ESM format targeting Node.js 18+.

### Why Two Entry Points?

The proxy daemon is bundled separately so `silo start` can spawn it as a lightweight detached process without pulling in the entire CLI dependency graph (Commander, Inquirer, etc.).

### TypeScript Configuration

- **Target:** ES2022
- **Module:** ESNext with bundler resolution
- **Strict mode:** enabled
- **Source maps:** enabled
- **Declarations:** enabled

---

## Testing

SILO uses [Vitest](https://vitest.dev/) for testing.

### Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run a specific test file
npx vitest run tests/policy/engine.test.ts

# Run tests with coverage
npx vitest run --coverage
```

### Test Structure

```
tests/
├── audit/
│   ├── audit.test.ts           # JSONL serialisation, filtering logic
│   ├── tool-calls.test.ts      # Tool call extraction (OpenAI + Anthropic)
│   └── traces.test.ts          # Framework trace ingestion
├── commands/
│   └── onboard.test.ts         # Config writing, wizard flow (mocked prompts)
├── config/
│   ├── encryption.test.ts      # AES-256-GCM round-trips, tamper detection
│   └── manager.test.ts         # Config read/write/patch tests
├── docker/
│   └── templates.test.ts       # Security flag snapshot tests
├── frameworks/
│   ├── docker-builder.test.ts  # Framework-aware image build flags
│   └── registry.test.ts        # Framework registry completeness
├── integrations/
│   ├── deep-integration.test.ts
│   ├── resolver.test.ts         # Integration routing, auth injection
│   └── templates.test.ts        # Built-in template validation
├── policy/
│   ├── engine.test.ts           # Policy evaluation, glob matching, YAML parsing
│   └── presets.test.ts          # Preset apply/remove/idempotency
└── proxy/
    ├── provider.test.ts         # Provider routing, auth header injection/stripping
    └── server.test.ts           # HTTP proxy server + prompt IPC endpoints
```

> The test suite runs quickly and does not require a Docker daemon.

### Test Coverage Areas

| Module | Tests | Coverage |
|---|---|---|
| **Policy Engine** | 20 | Rule evaluation, glob matching (`*`, `**`, `{a,b}`), YAML parsing, error handling |
| **Presets** | 13 | Registry completeness, apply/remove idempotency, merge-without-duplicates |
| **Provider** | 12 | OpenAI/Anthropic/Local routing, auth injection, Bearer vs x-api-key, stripped headers |
| **Proxy Server** | 11 | HTTP proxy routing, prompt IPC endpoints, health check endpoint |
| **Audit** | 15 | JSONL round-trip, malformed line skipping, category/verdict/session/date filtering |
| **Tool Calls** | 16 | Tool call extraction from streaming + non-streaming OpenAI and Anthropic responses |
| **Traces** | 16 | Framework trace ingestion, validation, unknown event handling |
| **Encryption** | 16 | AES-256-GCM round-trips, idempotency helpers, tamper detection, unicode |
| **Config Manager** | 14 | Config read/write/patch, encryption on write, decryption on read |
| **Docker Templates** | 17 | Security flag snapshot tests (`--cap-drop`, `--read-only`, `--security-opt`) |
| **Frameworks** | 22 | Registry completeness, docker-builder image flags |
| **Integrations** | 45 | Routing, auth injection, query-param auth, template validation, deep integration |
| **Onboard** | 2 | Config writing, existing config detection, `--force` flag |

### Testing Strategy

- **Unit tests only** — no Docker or network dependencies in CI
- **Mocking** — `conf`, `inquirer`, `ora`, `node:fs` are mocked for isolated testing
- **Temporary files** — policy engine tests write YAML to OS temp directory, cleaned up in `afterEach`

---

## Linting & Type Checking

```bash
# Type check
npx tsc --noEmit

# Build (implicitly type-checks)
npm run build
```

---

## Dev Install

For development, use the install script in dev mode to create a global `silo` symlink:

```bash
./install.sh --dev
```

This creates a symlink at `/usr/local/bin/silo` that points to the TypeScript source via `npx tsx`, so changes to source files take effect immediately without rebuilding.

---

## Key Design Decisions

### ESM-Only

The project is fully ESM (no CommonJS). This means:
- All imports use `.js` extensions (even for `.ts` files)
- `"type": "module"` in `package.json`
- `tsconfig.json` uses `"module": "ESNext"` with `"moduleResolution": "bundler"`

### Zod for Validation

All external data boundaries use Zod schemas:
- Config file → `SiloConfigSchema`
- Policy files → `PolicySchema`
- CLI arguments → Commander + Zod where applicable

### execa for Subprocesses

All Docker commands are dispatched via `execa` with argument arrays to prevent shell injection. Never use template literals or `child_process.exec` with string interpolation.

### Detached Daemon Pattern

The proxy daemon is managed via PID file + health endpoint rather than a parent-child process relationship. This allows the CLI to exit while the proxy keeps running.

---

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes
4. Ensure tests pass: `npm test`
5. Ensure the build works: `npm run build`
6. Submit a pull request

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add Docker image caching
fix: handle CONNECT tunnel timeout
docs: update policy engine guide
test: add glob pattern edge cases
refactor: extract provider routing logic
```

---

*SILO v0.2.0 — Secure AI Agent Sandbox Orchestrator*
