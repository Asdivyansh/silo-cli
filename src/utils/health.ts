/**
 * Proxy Health Check & Auto-restart
 *
 * Provides utilities to check if the inference proxy daemon is alive
 * and healthy, and to automatically restart it if it has crashed.
 *
 * The proxy exposes a `/_silo/health` endpoint that returns:
 *   { "status": "ok", "pid": <number>, "uptimeMs": <number> }
 *
 * `ensureProxyRunning` is called by `silo connect` and `silo run` to
 * transparently recover from proxy crashes without manual intervention.
 */
import { request } from "node:http";
import { log } from "./logger.js";
import { isProxyAlive, readPid } from "./pid.js";
import type { SiloConfig } from "../config/schema.js";

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

export interface HealthResponse {
  status: string;
  pid: number;
  uptimeMs: number;
}

/**
 * Send a health check request to the proxy daemon.
 * Returns the health response if the proxy is responsive, or null if unreachable.
 */
export function checkProxyHealth(port: number): Promise<HealthResponse | null> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve(null);
    }, 2000);

    try {
      const req = request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/_silo/health",
          method: "GET",
          timeout: 2000,
        },
        (res) => {
          let body = "";
          res.on("data", (chunk: Buffer) => {
            body += chunk.toString();
          });
          res.on("end", () => {
            clearTimeout(timeout);
            try {
              resolve(JSON.parse(body) as HealthResponse);
            } catch {
              resolve(null);
            }
          });
        },
      );

      req.on("error", () => {
        clearTimeout(timeout);
        resolve(null);
      });

      req.on("timeout", () => {
        req.destroy();
        clearTimeout(timeout);
        resolve(null);
      });

      req.end();
    } catch {
      clearTimeout(timeout);
      resolve(null);
    }
  });
}

// ---------------------------------------------------------------------------
// Auto-restart
// ---------------------------------------------------------------------------

/**
 * Ensure the proxy daemon is running and healthy.
 *
 * 1. Check if the PID file indicates a running process
 * 2. If alive, send a health check to verify responsiveness
 * 3. If dead or unresponsive, respawn the daemon
 *
 * This is called by `silo connect` and `silo run` to transparently
 * recover from proxy crashes.
 */
export async function ensureProxyRunning(config: SiloConfig): Promise<void> {
  const port = config.proxy.port;

  // Quick check: is the process alive at all?
  if (await isProxyAlive()) {
    // Process exists — verify it's responsive
    const health = await checkProxyHealth(port);
    if (health?.status === "ok") {
      return; // All good
    }
    log.warn("Proxy daemon is alive but not responding — restarting…");
    // Kill the unresponsive process
    const pid = await readPid();
    if (pid) {
      try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
    }
  }

  // Proxy is dead — restart it
  log.info("Proxy daemon not running — auto-restarting…");
  await restartProxyDaemon(port);
}

/**
 * Spawn the proxy daemon using the shared spawner.
 */
async function restartProxyDaemon(port: number): Promise<void> {
  const { spawnProxyDaemon } = await import("../proxy/spawn.js");
  await spawnProxyDaemon(port);
}
