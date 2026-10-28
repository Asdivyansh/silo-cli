# Agent Runner

> How SILO orchestrates LLM-powered agent tasks inside secure sandboxes.

> [!NOTE]
> **Looking to run your own agent framework?** This page covers the **built-in** agent runner (`silo run`), which is a simple, quick-task tool. For running full agent frameworks like OpenClaw, AutoGPT, or CrewAI inside the sandbox, see **[Running External Agents](./sandbox-agents.md)** and **[Integration Patterns](./integration-patterns.md)**.

---

## Overview

The agent runner (`silo run`) orchestrates a complete LLM tool-calling loop on the host side. It sends tasks to the configured LLM, executes tool calls inside the sandboxed container, feeds results back, and loops until completion.

```
User → silo run "task" → LLM → tool_calls → docker exec → results → LLM → ... → final response
```

---

## Execution Loop

### Step-by-Step Flow

1. **Validate prerequisites**
   - Check config exists
   - Verify Docker is available
   - Confirm the named container is running
   - Ensure the proxy daemon is alive (auto-restart if needed)

2. **Build initial messages**
   ```
   messages = [
     { role: "system", content: system_prompt_with_task },
     { role: "user",   content: task_text }
   ]
   ```

3. **For each turn** (up to `--max-turns`):
   a. Send messages to the LLM with tool definitions
   b. Parse the response
   c. If response contains `tool_calls`:
      - Execute each command inside the sandbox via `docker exec`
      - Capture stdout, stderr, exit code
      - Append tool results to message history
      - Continue to next turn
   d. If response contains only text (no tool calls):
      - Display the final response
      - Agent is complete

4. **If max turns reached**: Warn and stop

---

## Tool Definitions

The agent has access to three tools:

### `execute_command`

Run a shell command inside the sandbox. Returns stdout, stderr, and exit code.

```json
{
  "name": "execute_command",
  "parameters": {
    "command": "string (required) — The shell command to execute"
  }
}
```

### `read_file`

Read file contents from the sandbox. Faster than `cat` for large files.

```json
{
  "name": "read_file",
  "parameters": {
    "path": "string (required) — Path relative to /workspace or absolute",
    "max_lines": "number (optional, default 200) — Max lines to read"
  }
}
```

### `write_file`

Write content to a file inside the sandbox. Creates parent directories if needed.

```json
{
  "name": "write_file",
  "parameters": {
    "path": "string (required) — Path relative to /workspace or absolute",
    "content": "string (required) — The file content to write"
  }
}
```

### Tool Result Format

```json
{
  "stdout": "output text...",
  "stderr": "error text...",
  "exitCode": 0
}
```

---

## Command Execution

Commands run inside the sandbox via `docker exec`:

```bash
docker exec --workdir /workspace <container_name> /bin/sh -c "<command>"
```

### Timeouts and Limits

| Limit | Value | Purpose |
|---|---|---|
| Per-command timeout | **120 seconds** | Prevents runaway processes (some pip installs take time) |
| LLM request timeout | **120 seconds** | Prevents hanging on slow LLM responses |
| Max turns | **10** (configurable via `--max-turns`) | Prevents infinite loops |
| stdout display | First 2,000 characters | Keeps terminal output readable |
| stderr display | First 1,000 characters | Highlights errors without flooding |
| stdout → LLM | First 8,000 characters | Stays within token limits |
| stderr → LLM | First 2,000 characters | Stays within token limits |

### Error Handling

- **Non-zero exit codes** are not treated as errors — the exit code is passed back to the LLM alongside stdout/stderr
- **Timeout errors** are caught and returned as stderr with exit code 1
- **Unknown tool calls** produce an error message back to the LLM: `Error: Unknown tool "<name>". Available tools: execute_command, read_file, write_file.`
- **Invalid JSON arguments** produce: `Error: Invalid JSON arguments.`
- **Empty required parameters** produce: `Error: '<param>' parameter is required.`

---

## System Prompt

The system prompt gives the LLM context about the sandbox environment:

```
You are an AI agent running inside a secure sandbox container.
Your working directory is /workspace which is mounted from the host.

You have access to these tools:
  - `execute_command` — run any shell command
  - `read_file` — read file contents (faster than cat for large files)
  - `write_file` — write/create files (faster than echo/heredoc)

Use them to accomplish the task below. You can call multiple tools.
When the task is complete, provide a summary of what you did.

Available programs in the sandbox: python3, pip, curl, git, jq, and standard Unix utilities.

TASK: <user's task>
```

---

## Multi-Provider Support

The agent runner supports three LLM providers, automatically adapting the request/response format.

### OpenAI (and Local/OpenAI-Compatible)

- **Request format:** Standard OpenAI chat completions API
- **Endpoint:** `POST /v1/chat/completions`
- **Tool format:** `tools` array with `tool_choice: "auto"`
- **Response parsing:** `choices[0].message.tool_calls` array

### Anthropic

- **Request format:** Anthropic Messages API
- **Endpoint:** `POST /v1/messages`
- **Automatic conversions:**
  - System message → extracted to top-level `system` field
  - `tool` role messages → converted to `user` role with `tool_result` content blocks
  - Assistant messages with `tool_calls` → converted to `tool_use` content blocks
- **Tool format:** `input_schema` instead of `parameters`
- **Response parsing:** Content blocks with `type: "tool_use"` → normalised to OpenAI `tool_calls` format

### Proxy Routing

All LLM calls from `silo run` are **routed through the local inference proxy** at `http://127.0.0.1:{port}`. This ensures:
- Every agent LLM call appears in the unified audit log
- Policy checks are applied consistently
- Credential injection is handled by the proxy (not the runner)
- The runner never holds API keys directly

The proxy adds an `x-silo-runner: silo-run` header to tag these entries in the audit log.

---

## Command-Line Options

```bash
silo run <task> [options]
```

| Option | Type | Default | Description |
|---|---|---|---|
| `<task>` | string | — | The task description (required) |
| `-m, --max-turns <n>` | integer | `10` | Maximum conversation turns |
| `-n, --name <agent>` | string | from config | Target a specific named agent |
| `-p, --policy <file>` | string | — | Policy file override |
| `--no-stream` | boolean | `false` | Disable streaming output |

---

## Output Format

The runner displays structured output during execution:

```
╭──────────────────────────────────────╮
│  SILO  v0.2.0                        │
│  Secure AI Agent Sandbox Orchestrator│
╰──────────────────────────────────────╯

ℹ  Agent:  silo-agent
ℹ  Model:  gpt-4o
ℹ  Task:   Create a Python script that prints fibonacci numbers

── Turn 1/10 ──

⚡ execute_command: cat > /workspace/fib.py << 'EOF'
def fibonacci(n):
    a, b = 0, 1
    for _ in range(n):
        yield a
        a, b = b, a + b

for num in fibonacci(20):
    print(num)
EOF
exit code: 0

── Turn 2/10 ──

⚡ execute_command: python3 /workspace/fib.py
0
1
1
2
3
5
8
13
21
34
55
89
144
233
377
610
987
1597
2584
4181
exit code: 0

── Turn 3/10 ──

✔ Agent response:

I created `/workspace/fib.py` which outputs the first 20 Fibonacci numbers.

✔ Agent completed in 3 turn(s).
```

---

## Examples

### Basic Task

```bash
silo run "Create a Python script that calculates fibonacci numbers"
```

### Complex Task with More Turns

```bash
silo run "Set up a Flask API with JWT authentication and write tests" --max-turns 20
```

### Multi-Agent Task

```bash
silo run "Add responsive CSS to the frontend" --name frontend
silo run "Add rate limiting to the API" --name backend
```

### CI/Automation

```bash
silo run "Run the test suite and fix any failures" --max-turns 15
EXIT_CODE=$?
silo logs --json > agent-audit.jsonl
```

---

## Security Considerations

1. **All commands execute inside the sandbox** — the agent can never touch the host filesystem (except through the mounted `/workspace` volume)
2. **120-second timeout** prevents runaway processes
3. **Output truncation** prevents memory exhaustion from large command outputs
4. **Proxy health is verified** before starting to ensure audit coverage
5. **All LLM calls route through the proxy** for unified audit logging and credential injection
6. **API keys are encrypted at rest** using AES-256-GCM with a machine-bound key
7. **`read_file` and `write_file` use direct execution** (using `head` and `tee` inside the container with argument arrays and stdin piping) instead of invoking a shell interpreter, completely preventing shell injection via file paths or content.

---

*SILO v0.2.0 — Secure AI Agent Sandbox Orchestrator*
