# Troubleshooting

> Common issues and their solutions.

---

## Docker Issues

### "Docker is not available" / "Docker is not running or not installed"

```bash
# Verify Docker is installed and running
docker info

# If not running, start Docker Desktop (macOS)
open -a "Docker"

# On Linux, ensure the daemon is running
sudo systemctl start docker

# Ensure your user is in the docker group (Linux)
sudo usermod -aG docker $USER
# Log out and back in for group changes to take effect
```

### "Sandbox image not found"

```bash
# Build the sandbox image
silo build

# Verify it exists
docker images | grep silo-sandbox

# Force rebuild (no cache)
silo build --no-cache
```

### Container Won't Start — "name is already in use"

```bash
# Remove the stale container
docker rm --force silo-agent

# Or use the configured container name
docker rm --force silo-<name>

# Then start again
silo start
```

### Multiple Stale Containers

```bash
# List all SILO-managed containers (running and stopped)
docker ps -a --filter label=managed-by=silo

# Remove all stopped SILO containers
docker container prune --filter label=managed-by=silo

# Nuclear option: stop and remove all SILO containers
silo stop --all
```

---

## Framework Issues

### OpenClaw TUI Says "Node.js v22.19+ is required"

OpenClaw requires Node.js 22.19 or newer inside the sandbox. If `silo connect --tui` reports an older Node version, the running container was created from an older OpenClaw image.

```bash
silo stop
silo build --framework openclaw --no-cache
silo start --framework openclaw
silo connect --tui
```

If you use browser mode, include `--browser` on both build and start:

```bash
silo stop
silo build --framework openclaw --browser --no-cache
silo start --framework openclaw --browser --desktop
silo connect --tui
```

You can verify the runtime inside the container:

```bash
docker exec silo-agent node --version
```

---

## Proxy Issues

### "Inference proxy not running"

```bash
# Check proxy status
silo status

# The proxy auto-restarts when you run silo connect or silo run
# For manual restart:
silo stop
silo start

# Check if the PID file is stale
cat ~/.silo/proxy.pid
kill -0 $(cat ~/.silo/proxy.pid) 2>/dev/null && echo "alive" || echo "dead"

# Manual cleanup
rm ~/.silo/proxy.pid
silo start
```

### "Connection refused from inside the sandbox"

```bash
# Open a shell in the sandbox
silo connect

# Test proxy connectivity
curl -v http://llm.gateway:8199/_silo/health
# Should return: {"status":"ok","pid":...,"uptimeMs":...}

# Check proxy environment
echo $http_proxy
echo $https_proxy
# Should show: http://llm.gateway:8199

# Check /etc/hosts
cat /etc/hosts | grep llm.gateway
# Should show: <host-ip>   llm.gateway

# Exit sandbox and check the Docker network
exit
docker network inspect silo-sandbox-net
```

### "Connection reset" or "Connection timed out"

```bash
# The proxy may have crashed — check health
curl http://127.0.0.1:8199/_silo/health

# Force restart
silo stop
silo start

# Check with debug logging
SILO_DEBUG=1 silo start
```

### Proxy Port Conflict

```bash
# Check if port 8199 is already in use
lsof -i :8199

# If occupied, reconfigure (edit config manually or re-run onboard)
silo onboard --force
```

---

## Policy Issues

### "Policy blocks everything"

```bash
# Check which policy is active
silo policy show

# Apply presets for common hosts
silo policy apply pypi       # Python packages
silo policy apply npm        # Node.js packages
silo policy apply github     # Git operations

# Add individual hosts
silo policy add api.github.com
silo policy add example.com

# Hot-reload without restarting
silo policy reload
```

### "Policy changes not taking effect"

```bash
# Force a policy reload
silo policy reload

# Check the proxy received the reload (with debug)
SILO_DEBUG=1 silo policy reload

# Verify the active policy
silo policy show

# If all else fails, restart the proxy
silo stop
silo start
```

### "Invalid policy schema" Error

```bash
# Validate your policy file
cat ~/.silo/policy.yaml

# Common issues:
# 1. Missing required fields (version, name, default, rules)
# 2. Invalid action (must be "allow" or "deny")
# 3. Empty host field
# 4. Invalid YAML syntax
```

Example of a valid minimal policy:
```yaml
version: "1"
name: "my-policy"
default: deny
rules:
  - host: "llm.gateway"
    action: allow
```

---

## LLM Issues

### "API key not working" / "401 Unauthorized"

```bash
# Re-run onboard to update your API key
silo onboard --force

# Test your key directly (outside SILO)
curl https://api.openai.com/v1/models \
  -H "Authorization: Bearer $OPENAI_API_KEY"

# For Anthropic
curl https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-6","max_tokens":10,"messages":[{"role":"user","content":"test"}]}'
```

### "Token usage shows '—' in logs"

Token usage reporting depends on the LLM provider:

| Provider | Non-Streaming | Streaming |
|---|---|---|
| **OpenAI** | ✅ Always included | Only with `stream_options.include_usage: true` |
| **Anthropic** | ✅ Always included | Included in `message_delta` event |
| **Local (Ollama)** | Usually included | Often missing |

For OpenAI streaming, ensure the request includes:
```json
{
  "stream": true,
  "stream_options": { "include_usage": true }
}
```

### "Model not found" / "Invalid model"

```bash
# Check your configured model
silo status

# Update via onboard
silo onboard --force

# Common model names:
# OpenAI:    gpt-4o, gpt-4o-mini, gpt-4-turbo, o1, o3-mini
# Anthropic: claude-sonnet-4-6, claude-opus-4-6, claude-haiku
# Local:     llama3, mistral, codellama
```

---

## Agent Runner Issues

### "Agent hits max turns without completing"

```bash
# Increase the turn limit
silo run "complex task" --max-turns 20

# Or simplify the task into smaller steps
silo run "Step 1: Create the project structure"
silo run "Step 2: Add the main application logic"
```

### "Command timed out" Inside Sandbox

Commands timeout after 120 seconds. If a command legitimately takes longer:

1. Break it into smaller steps in the task description
2. Pre-install dependencies before running the agent:
   ```bash
   silo connect
   pip install large-package
   exit
   silo run "Use the pre-installed package to..."
   ```

### "Permission denied" in /workspace

```bash
# Check ownership
silo connect
ls -la /workspace

# The container runs as UID 1001:1001
# Ensure the host directory is writable by that user
exit
chmod -R 777 ~/silo-workspace  # Quick fix
# Or:
chown -R 1001:1001 ~/silo-workspace  # Proper fix
```

---

## Build Issues

### "npm run build fails"

```bash
# Check for TypeScript errors
npx tsc --noEmit

# Clean build
rm -rf dist
npm run build

# Verify Node version
node --version  # Must be 18+

# Reinstall dependencies
rm -rf node_modules
npm install
npm run build
```

### "Cannot find module" After Build

```bash
# Ensure all dependencies are installed
npm install

# Check that dist/ was generated
ls dist/

# Should contain:
# cli.js
# cli.js.map
# proxy-daemon.js
# proxy-daemon.js.map
```

---

## Configuration Issues

### "No config found. Run `silo onboard` first."

```bash
silo onboard
```

### "Corrupted config"

```bash
# View the config file
cat "$(silo status 2>&1 | grep 'Config file' | awk '{print $NF}')"

# Or find it manually
cat ~/Library/Preferences/cli-silo-nodejs/config.json   # macOS
cat ~/.config/cli-silo-nodejs/config.json               # Linux

# Reset config
silo onboard --force
```

> **Note:** Since v0.2.0, the `apiKey` and integration `token` fields are **encrypted at rest** using AES-256-GCM. Values starting with `enc:v1:` in the config file are normal — they will be transparently decrypted when read by SILO.

### "enc:v1:..." Values in Config — Expected

If you open the config file and see values like:
```json
"apiKey": "enc:v1:a1b2c3...:d4e5f6...:g7h8i9..."
```

This is **correct** — the API key is encrypted at rest. SILO decrypts it transparently when needed.

If decryption fails (e.g. you copied the config from another machine), re-run onboard:
```bash
silo onboard --force
```

### Config File Location

```bash
# macOS
~/Library/Preferences/cli-silo-nodejs/config.json

# Linux
~/.config/cli-silo-nodejs/config.json

# Find it programmatically
node -e "const Conf = require('conf'); const c = new Conf({projectName:'cli-silo'}); console.log(c.path)"
```

---

## Network Issues

### Docker Network Won't Delete

```bash
# List networks
docker network ls | grep silo

# Check attached containers
docker network inspect silo-sandbox-net

# Remove all SILO containers first
silo stop --all

# Then remove the network
docker network rm silo-sandbox-net
```

### DNS Resolution Issues Inside Container

```bash
# Enter the sandbox
silo connect

# Check hosts file
cat /etc/hosts
# Should show: <host-ip>  llm.gateway

# Test resolution
ping llm.gateway  # Should resolve to host IP

# Test proxy connection
curl http://llm.gateway:8199/_silo/health
```

### Docker Desktop (macOS/Windows): proxy unreachable from the sandbox

**Issue:** Under Docker Desktop, containers run inside a VM, so the `--internal` sandbox network has no direct route to the host-side inference proxy. SILO bridges this with the `silo-gateway` egress sidecar — if the sidecar is missing or stopped, every in-sandbox request to `llm.gateway` fails.

**Solutions:**
1. **Automatic handling:** `silo start` creates (or repairs) the `silo-gateway` sidecar automatically. Check that it is running and attached to the sandbox network:
   ```bash
   docker ps --filter name=silo-gateway
   docker network inspect silo-sandbox-net --format '{{range .Containers}}{{.Name}} {{end}}'
   ```
2. **Recreate the sidecar:** If it is missing, stopped, or was created with a stale port/integration configuration:
   ```bash
   silo stop --all
   silo start
   ```
3. **Verify connection route:**
   ```bash
   # Inside the sandbox, curl the proxy through the gateway alias
   silo connect
   curl -v http://llm.gateway:8199/_silo/health
   ```
4. **Run diagnostics:** `silo doctor` includes an "Egress Gateway Sidecar" check and an in-sandbox reachability probe on Docker Desktop platforms.

---

## Debug Mode

When in doubt, enable debug logging for verbose output:

```bash
SILO_DEBUG=1 silo <command>
```

Debug output includes:
- Docker command arguments
- Proxy request routing
- Policy evaluation details
- Config read/write operations
- PID file operations
- Health check results

---

## Getting Help

If these solutions don't resolve your issue:

1. Enable debug logging: `SILO_DEBUG=1 silo <command>`
2. Check the audit log: `silo logs --json --tail 50`
3. Check Docker logs: `docker logs silo-agent`
4. Check proxy PID: `cat ~/.silo/proxy.pid`
5. Verify Docker: `docker info`
6. Open an issue with the debug output

---

*SILO v0.2.0 — Secure AI Agent Sandbox Orchestrator*
