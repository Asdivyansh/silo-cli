/**
 * SILO Inference Proxy Daemon
 *
 * This module is the entry point for the standalone proxy process that `silo
 * start` spawns as a detached child. It runs independently of the CLI process
 * and is managed via a PID file (~/.silo/proxy.pid).
 *
 * Lifecycle:
 *   spawn  — `silo start` forks this process detached, then returns to the shell
 *   run    — proxy listens on config.proxy.port, enforces policy, injects credentials
 *   stop   — `silo stop` sends SIGTERM → graceful shutdown within 5 s, then SIGKILL
 *   reload — SIGHUP triggers the policy engine to re-read the active YAML file
 */
import { readConfig } from "../config/manager.js";
import { writePid, clearPid } from "../utils/pid.js";
import { startProxyServer, stopProxyServer } from "./server.js";
import { loadPolicy, compilePolicy } from "../policy/engine.js";
import { log } from "../utils/logger.js";
import type { Policy, CompiledPolicy } from "../policy/engine.js";
import { startAuditSession, logSessionEvent } from "../audit/audit.js";
import { onPolicyUpdated } from "./interceptor.js";
import { createControlToken, clearControlToken } from "./control-token.js";
import { SILO_NETWORK } from "../docker/templates.js";
import { execa } from "execa";

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const _config = readConfig();

if (!_config) {
  process.stderr.write("[silo-proxy] No configuration found. Run `silo onboard`.\n");
  process.exit(1);
}

// TypeScript cannot narrow past process.exit(), so we assert non-null here.
let config = _config;

// Mutable reference that the proxy server accesses via getCompiledPolicy()
let activePolicy: Policy = {
  version: "1",
  name: "initialising",
  default: "deny",
  rules: [{ host: "llm.gateway", action: "allow" }],
};

// Pre-compiled policy — compiled once on load/reload, not per-request
let compiledPolicy: CompiledPolicy = compilePolicy(activePolicy);

async function reloadConfigAndPolicy(): Promise<void> {
  try {
    const newConfig = readConfig();
    if (newConfig) {
      config = newConfig;
      log.info("[proxy] configuration reloaded from disk");
    }
    activePolicy = await loadPolicy(config);
    compiledPolicy = compilePolicy(activePolicy);
    log.info(`[proxy] policy loaded: "${activePolicy.name}" (${activePolicy.rules.length} rules, compiled)`);
  } catch (err) {
    log.error(`[proxy] reload failed: ${String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Signal handlers
// ---------------------------------------------------------------------------

async function shutdown(signal: string): Promise<void> {
  log.info(`[proxy] received ${signal} — shutting down`);
  await logSessionEvent("session_stop");
  await stopProxyServer();
  await clearControlToken();
  await clearPid();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// SIGHUP = hot-reload the policy file and configuration without restarting the proxy
process.on("SIGHUP", () => {
  log.info("[proxy] received SIGHUP — reloading configuration and policy");
  void reloadConfigAndPolicy();
});

// Catch unhandled rejections so the daemon doesn't silently die
process.on("unhandledRejection", (reason) => {
  log.error(`[proxy] unhandled rejection: ${String(reason)}`);
});

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const sessionId = startAuditSession();
log.info(`[proxy] audit session: ${sessionId}`);

await writePid(process.pid);

await reloadConfigAndPolicy();

await logSessionEvent("session_start");

const trustedSourceCidrs = await resolveTrustedSourceCidrs();
if (trustedSourceCidrs.length > 0) {
  log.info(`[proxy] trusted Docker source CIDRs: ${trustedSourceCidrs.join(", ")}`);
}

// Register interceptor callback so "allow_always" decisions trigger
// an immediate policy recompile without a full daemon restart.
onPolicyUpdated(() => {
  log.info("[proxy] interceptor wrote a new allow rule — reloading configuration and policy");
  void reloadConfigAndPolicy();
});

// Secret for the operator-only prompt endpoints; read by the CLI listener.
const controlToken = await createControlToken();

await startProxyServer({
  port: config.proxy.port,
  getLlm: () => config.llm,
  trustedSourceCidrs,
  getCompiledPolicy: () => compiledPolicy,
  getIntegrations: () => config.integrations ?? [],
  controlToken,
});

// Keep the process alive — the server event loop holds Node open automatically,
// but this guard prevents an early exit if the server hasn't bound yet.
log.info(`[proxy] daemon ready (pid=${process.pid})`);

async function resolveTrustedSourceCidrs(): Promise<string[]> {
  try {
    const { stdout } = await execa("docker", [
      "network",
      "inspect",
      "--format",
      "{{json .IPAM.Config}}",
      SILO_NETWORK,
    ]);

    const parsed = JSON.parse(stdout) as Array<{ Subnet?: string }>;
    return parsed
      .map((entry) => entry.Subnet)
      .filter((subnet): subnet is string => Boolean(subnet));
  } catch (err) {
    log.warn(
      `[proxy] could not inspect Docker network "${SILO_NETWORK}" for trusted source CIDRs; ` +
        `only loopback clients will be accepted until the daemon is restarted. ${String(err)}`,
    );
    return [];
  }
}
