# Capability Profiles and Browser Mode

> How SILO keeps agent capabilities powerful, explicit, and secure.

SILO started with a simple promise: run useful AI agents without giving them your whole machine. That promise becomes harder as agents become more capable. A coding agent may only need a workspace and a shell. A local assistant may need a specific Desktop file. A browser-capable framework such as OpenClaw may need Chromium, a writable browser profile, and enough shared memory to keep the browser alive.

The wrong answer is one giant permissive sandbox. If every session gets local files, a browser, broad writable paths, and relaxed runtime flags, the product becomes easier to demo but weaker as a security boundary.

The better answer is **capability profiles**.

SILO now treats higher-risk abilities as explicit, composable profiles:

| Profile | What It Enables |
|---|---|
| default | Safe coding, text, API, shell, and `/workspace` tasks |
| `--desktop` | Host Desktop mounted as `/host/Desktop` |
| `--mount` | Explicit host folders mounted under `/host/...` |
| `--browser` | Sandboxed Chromium for framework browser automation |

This keeps the default path strict while still allowing a full OpenClaw-style workstation when the operator asks for it.

---

## The Design Goal

The goal is not to reduce agent capability. The goal is to make capability **intentional**.

Before capability profiles, users could run text-oriented agents safely, but browser automation exposed a real product tension:

- The framework might know how to use browser automation.
- The sandbox image might not contain a browser.
- Chromium needs writable cache/profile locations.
- Browser automation often needs larger `/dev/shm` and more memory than text-only agents.
- Giving the agent the host browser would expose cookies, logged-in accounts, password managers, and personal browsing state.

Capability profiles solve this by giving agents more power inside the sandbox, without silently expanding access to the host.

---

## Default Mode

Default mode remains the safest everyday mode.

```bash
silo start
```

or with a framework:

```bash
silo start --framework crewai
```

In default mode the agent gets:

- `/workspace` as the working project directory.
- A non-root UID/GID (`1001:1001`).
- A read-only root filesystem.
- A hardened `/tmp` mounted with `noexec,nosuid`.
- Dropped Linux capabilities.
- `no-new-privileges`.
- PID, CPU, and memory limits.
- Policy-governed HTTP egress through the SILO proxy.
- No host Desktop, Downloads, Documents, browser profile, SSH keys, or cloud credentials.

This is the right mode for coding, text processing, API calls, tests, framework experiments, and most repeatable agent work.

---

## Local Files Mode: `--desktop` and `--mount`

Agents can always read and write `/workspace`. They cannot see arbitrary host folders unless you mount them explicitly.

For Desktop workflows:

```bash
silo start --framework openclaw --desktop
```

Inside the sandbox, the host Desktop appears here:

```bash
/host/Desktop
```

So instead of asking the agent to write `~/Desktop/report.md`, ask it to write:

```bash
/host/Desktop/report.md
```

For other folders, use `--mount`:

```bash
silo start --mount ~/Downloads:/host/Downloads:ro
silo start --mount ~/Documents/safe-agent-folder:/host/Documents:rw
```

The target must be under `/host/...`. This prevents a mount from accidentally replacing important container paths such as `/etc`, `/usr`, or `/home/agent`.

This model is deliberately explicit. A local file task becomes possible, but the agent still does not get the rest of your home directory.

---

## Browser Mode: `--browser`

Browser mode is for framework images that need browser automation inside the sandbox.

```bash
silo build --framework openclaw --browser
silo start --framework openclaw --browser --desktop
```

You can also build browser-capable variants for every supported framework:

```bash
silo build --all-frameworks --browser
```

Browser mode does **not** control your host Chrome. It does not reuse your cookies, profile, sessions, password manager, or browser extensions. It runs Chromium inside the SILO container.

That distinction matters. The agent gets a browser, but not your browser.

---

## What Browser Build Adds

`silo build --framework <name> --browser` creates a separate image tag:

```text
silo-sandbox-<framework>-browser:latest
```

For example:

```text
silo-sandbox-openclaw-browser:latest
```

The browser-capable image adds:

- Chromium installed into the read-only image layer.
- Browser dependencies such as fonts and `xdg-utils`.
- A SILO Chromium launcher at `/usr/local/bin/silo-chromium`.
- Common browser command names routed to that launcher:
  - `chrome`
  - `google-chrome`
  - `chromium`
  - `chromium-browser`
- Browser environment variables for Playwright/Puppeteer-style tooling.

Useful environment variables inside the sandbox:

```bash
CHROME_BIN=/usr/local/bin/silo-chromium
CHROMIUM_BIN=/usr/local/bin/silo-chromium
BROWSER_EXECUTABLE_PATH=/usr/local/bin/silo-chromium
PUPPETEER_EXECUTABLE_PATH=/usr/local/bin/silo-chromium
PUPPETEER_SKIP_DOWNLOAD=true
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
SILO_BROWSER_PROFILE_DIR=/browser-profile
SILO_BROWSER_DOWNLOADS_DIR=/browser-downloads
SILO_BROWSER_ARGS="--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage --user-data-dir=/browser-profile"
```

The launcher applies the Docker-safe browser args consistently, even when a framework calls a common browser binary name directly.

---

## What Browser Start Adds

`silo start --framework <name> --browser` selects the browser-capable image and adds browser-specific runtime resources.

It keeps the normal sandbox hardening and adds:

```text
--shm-size 512m
--tmpfs /browser-cache:size=512m,uid=1001,gid=1001,nosuid
--tmpfs /browser-profile:size=256m,uid=1001,gid=1001,nosuid
--tmpfs /browser-downloads:size=256m,uid=1001,gid=1001,nosuid
```

Frameworks can also declare their own writable state mounts. OpenClaw, for example, gets a larger `/home/agent` tmpfs so gateway logs, sessions, and task state do not compete with the small default framework scratch size:

```text
--tmpfs /home/agent:size=256m,uid=1001,gid=1001,nosuid
```

It also keeps:

```text
--tmpfs /tmp:size=64m,noexec,nosuid
--read-only
--cap-drop ALL
--security-opt no-new-privileges
--user 1001:1001
```

The result is a browser that has the writable runfiles it needs, while `/tmp` remains hardened and the root filesystem remains read-only.

---

## Memory Behavior

Text-focused agents can often run with SILO's default `512m` memory limit. Headless Chromium is different. It can fail unpredictably if Docker memory or `/dev/shm` is too small.

Browser mode therefore raises the effective container memory limit to at least:

```text
2g
```

If your configured memory limit is already `2g` or higher, SILO keeps it. If it is lower, browser mode raises it for that run and prints that in startup output.

The browser tmpfs sizes are limits, not up-front allocations. Docker does not immediately consume all of that memory just because the tmpfs exists.

---

## Why Chromium Uses `--no-sandbox`

Chromium's own sandbox expects kernel features and privileges that conflict with SILO's hardened Docker runtime. SILO keeps Docker-level containment and runs Chromium with:

```text
--no-sandbox
--disable-setuid-sandbox
--disable-dev-shm-usage
```

This would be risky if it meant "run an unsandboxed browser on the host." That is not what SILO does.

In SILO, Chromium still runs:

- Inside a Docker container.
- As a non-root user.
- With all Linux capabilities dropped.
- With no-new-privileges.
- With a read-only root filesystem.
- With scoped writable tmpfs mounts.
- Behind SILO's network policy and proxy.

So a browser exploit is still trapped inside the same constrained container boundary as the agent.

---

## Integrations Still Work

Browser mode does not replace the integration system.

Credential-managed gateways such as:

```text
slack.gateway
github.gateway
notion.gateway
```

still work in browser mode. SILO continues to add Docker host aliases for configured integrations, and requests still route through the host-side proxy. Tokens remain outside the sandbox and are injected only by the proxy.

For example, an agent running in a browser-capable OpenClaw container can still call:

```bash
curl http://github.gateway:8199/repos/owner/repo/pulls
```

The agent sees the gateway. It does not see the GitHub token.

---

## Framework Coverage

Browser-capable image generation is available for every registered framework:

| Framework | Browser Image Pattern |
|---|---|
| CrewAI | `silo-sandbox-crewai-browser:latest` |
| LangGraph | `silo-sandbox-langgraph-browser:latest` |
| Aider | `silo-sandbox-aider-browser:latest` |
| SWE-Agent | `silo-sandbox-swe-agent-browser:latest` |
| OpenClaw | `silo-sandbox-openclaw-browser:latest` |

OpenClaw is the primary browser-automation target today, but the browser layer is not hardcoded to OpenClaw. This keeps the design ready for other frameworks that can use Chromium, Playwright, Puppeteer, or browser-aware tools.

---

## Common Workflows

### Text or coding agent

```bash
silo build --framework crewai
silo start --framework crewai
```

### Agent that needs the Desktop

```bash
silo start --framework openclaw --desktop
```

Then use:

```text
/host/Desktop
```

inside the sandbox.

### Agent that needs a specific local folder

```bash
silo start --framework aider --mount ~/Downloads:/host/Downloads:ro
```

### OpenClaw with browser automation and Desktop access

```bash
silo build --framework openclaw --browser
silo start --framework openclaw --browser --desktop
```

### Prepare all browser-capable framework images

```bash
silo build --all-frameworks --browser
```

---

## What This Does Not Do

Browser mode is intentionally scoped.

It does not:

- Control your host browser.
- Reuse your host browser profile.
- Access your cookies or password manager.
- Mount your whole home directory.
- Make all network requests unrestricted.
- Disable SILO's proxy, policy engine, audit trail, or container hardening.

If a task needs host files, use `--desktop` or `--mount`. If a task needs browser automation, use `--browser`. If it needs both, combine them explicitly.

---

## Release Checks Added

The implementation is covered by tests for:

- Browser-capable image tags for every framework.
- Browser-capable Dockerfile generation for every framework.
- Browser runtime flags, tmpfs mounts, and environment variables.
- Default runtime behavior staying unchanged.
- Browser memory parsing and auto-raise behavior.
- Integration gateway aliases still being present in browser mode.

The current test suite covers the capability profile behavior without requiring Docker image downloads during unit tests.

---

## The Product Shape

The important product decision is that SILO is not becoming one permissive environment. It is becoming a set of explicit capability profiles:

```text
default    -> safe coding/text/API sandbox
--desktop  -> local Desktop through /host/Desktop
--mount    -> explicit host folders
--browser  -> sandboxed Chromium for framework browser automation
```

That keeps the main promise intact: agents can become more capable without silently becoming more trusted.
