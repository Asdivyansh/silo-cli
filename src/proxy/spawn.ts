/**
 * Proxy Daemon Spawner
 *
 * Shared module for resolving and spawning the proxy daemon process.
 * Used by both `silo start` and the health auto-restart system to avoid
 * duplicating the daemon discovery and spawn logic.
 */
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  statSync,
  renameSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../utils/logger.js";

/** Rotate the daemon log once it exceeds this size (override: SILO_LOG_MAX_BYTES). */
const DEFAULT_PROXY_LOG_MAX_BYTES = 5 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Absolute path to the proxy daemon's diagnostic log file. */
export function proxyLogPath(): string {
  return join(homedir(), ".silo", "logs", "proxy.log");
}

/**
 * Resolve the compiled proxy daemon entry point.
 *
 * Searches for the built JS file first, then falls back to the TypeScript
 * source for `tsx` dev mode.
 */
export function resolveDaemonPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "proxy-daemon.js"),              // dist/proxy/ → dist/proxy-daemon.js
    join(here, "proxy-daemon.js"),                    // dist/ (flat bundle)
    join(here, "..", "..", "dist", "proxy-daemon.js"), // src/proxy/ → dist/ (dev)
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Fallback for tsx dev mode — daemon runs as TypeScript
  return join(here, "daemon.ts");
}

/**
 * Spawn the proxy daemon as a detached background process.
 * Waits briefly for the daemon to bind, then returns.
 *
 * The daemon's stdout/stderr are appended to ~/.silo/logs/proxy.log
 * (timestamped via SILO_LOG_TIMESTAMPS) so policy reloads, request
 * errors, and crash reasons survive the detach and can be inspected
 * with `silo doctor` or directly.
 */
export async function spawnProxyDaemon(port: number): Promise<void> {
  const daemonPath = resolveDaemonPath();
  const isTs = daemonPath.endsWith(".ts");

  const logFd = openDaemonLog();

  const child = spawn(
    isTs ? "npx" : "node",
    isTs ? ["tsx", daemonPath] : [daemonPath],
    {
      detached: true,
      stdio: logFd === null ? "ignore" : ["ignore", logFd, logFd],
      env: { ...process.env, SILO_LOG_TIMESTAMPS: "1" },
    },
  );

  child.unref();

  // The child holds its own duplicate of the descriptor.
  if (logFd !== null) {
    try {
      closeSync(logFd);
    } catch {
      // ignore
    }
  }

  if (child.pid === undefined) {
    log.error("Failed to spawn proxy daemon — child.pid is undefined");
    return;
  }

  // Poll health check until healthy or timeout (5 seconds)
  const maxWaitMs = 5000;
  const pollIntervalMs = 100;
  const startWait = Date.now();
  let isHealthy = false;

  const { checkProxyHealth } = await import("../utils/health.js");

  while (Date.now() - startWait < maxWaitMs) {
    try {
      const health = await checkProxyHealth(port);
      if (health?.status === "ok") {
        isHealthy = true;
        break;
      }
    } catch {
      // ignore errors during startup
    }
    await sleep(pollIntervalMs);
  }

  if (isHealthy) {
    const { readPid } = await import("../utils/pid.js");
    const pid = await readPid();
    log.success(`Proxy daemon started (pid=${pid ?? child.pid}, port=${port})`);
  } else {
    log.error(`Proxy daemon failed to start or respond on port ${port} within 5s.`);
    log.info(`Daemon log: ${proxyLogPath()}`);
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
    throw new Error(
      `Proxy daemon failed to start on port ${port}. See ${proxyLogPath()} for details.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Open the daemon log for appending, rotating it first when oversized.
 * Returns null if the file cannot be opened — the daemon then runs with
 * stdio ignored rather than failing the start.
 */
function openDaemonLog(): number | null {
  const logPath = proxyLogPath();
  try {
    mkdirSync(dirname(logPath), { recursive: true });

    const maxBytes =
      parseInt(process.env["SILO_LOG_MAX_BYTES"] ?? "", 10) || DEFAULT_PROXY_LOG_MAX_BYTES;
    if (existsSync(logPath) && statSync(logPath).size >= maxBytes) {
      // Keep one previous generation: proxy.log → proxy.log.1
      renameSync(logPath, `${logPath}.1`);
    }

    return openSync(logPath, "a");
  } catch (err) {
    log.debug(`Could not open daemon log at ${logPath}: ${String(err)}`);
    return null;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
