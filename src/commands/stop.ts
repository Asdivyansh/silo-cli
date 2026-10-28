import ora from "ora";
import { execa } from "execa";
import { readConfig, patchConfig } from "../config/manager.js";
import { stopContainer } from "../docker/runner.js";
import { SILO_NETWORK } from "../docker/templates.js";
import { GATEWAY_CONTAINER, removeGatewaySidecar } from "../docker/gateway.js";
import { log } from "../utils/logger.js";
import {
  assertDockerAvailable,
  containerExists,
  isContainerRunning,
} from "../utils/system.js";
import { stopProxyProcess, isProxyAlive, readPid } from "../utils/pid.js";

interface StopOptions {
  name?: string;
  all?: boolean;
}

export async function runStop(opts: StopOptions = {}): Promise<void> {
  const config = readConfig();
  if (!config) {
    log.error("No configuration found. Run `silo onboard` first.");
    process.exit(1);
  }

  await assertDockerAvailable();

  let stoppedSomething = false;

  if (opts.all) {
    // ── Stop ALL silo-managed containers ────────────────────────────────
    stoppedSomething = await stopAllAgents();
  } else {
    // ── Stop a single container ────────────────────────────────────────
    const containerName = opts.name ? `silo-${opts.name}` : config.sandbox.containerName;
    stoppedSomething = await stopSingleAgent(containerName);
  }

  // ── Stop proxy daemon (only when stopping all or default) ──────────────
  const shouldStopProxy = opts.all || !opts.name;
  if (shouldStopProxy) {
    if (await isProxyAlive()) {
      const pid = await readPid();
      const spinner = ora(`Stopping inference proxy (pid=${pid ?? "?"})…`).start();
      try {
        await stopProxyProcess();
        spinner.succeed("Inference proxy stopped.");
        stoppedSomething = true;
      } catch (err) {
        spinner.fail("Failed to stop proxy daemon");
        log.error(err instanceof Error ? err.message : String(err));
      }
    } else {
      log.info("Proxy daemon is not running — skipping.");
    }

    // Persist running=false in config
    try {
      patchConfig({ proxy: { port: config.proxy.port, running: false, autoOpenLogs: config.proxy.autoOpenLogs } });
    } catch {
      // Non-fatal if config doesn't exist
    }

    // ── Remove Docker network (only if no other containers use it) ────
    await cleanupSiloNetwork();
  }

  if (stoppedSomething) {
    log.blank();
    log.success("Sandbox shut down cleanly.");
  }
}

// ---------------------------------------------------------------------------
// Container stop helpers
// ---------------------------------------------------------------------------

async function stopSingleAgent(containerName: string): Promise<boolean> {
  if (await containerExists(containerName)) {
    const running = await isContainerRunning(containerName);
    const spinner = ora(
      running
        ? `Stopping sandbox "${containerName}"…`
        : `Removing stopped container "${containerName}"…`,
    ).start();
    try {
      await stopContainer(containerName);
      spinner.succeed(`Sandbox "${containerName}" removed.`);
      return true;
    } catch (err) {
      spinner.fail("Failed to stop sandbox");
      log.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  } else {
    log.info(`No container named "${containerName}" found — skipping.`);
  }
  return false;
}

async function stopAllAgents(): Promise<boolean> {
  try {
    const { stdout } = await execa("docker", [
      "ps", "-a",
      "--filter", "label=managed-by=silo",
      "--format", "{{.Names}}",
    ]);

    const names = stdout.trim().split("\n").filter(Boolean);
    if (names.length === 0) {
      log.info("No SILO agent containers found.");
      return false;
    }

    let stopped = false;
    for (const name of names) {
      const spinner = ora(`Stopping "${name}"…`).start();
      try {
        await stopContainer(name);
        spinner.succeed(`Removed "${name}"`);
        stopped = true;
      } catch (err) {
        spinner.fail(`Failed to stop "${name}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return stopped;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Network cleanup
// ---------------------------------------------------------------------------

async function cleanupSiloNetwork(): Promise<void> {
  try {
    // docker network inspect returns the list of connected containers
    const { stdout } = await execa("docker", [
      "network", "inspect",
      "--format", "{{range .Containers}}{{.Name}} {{end}}",
      SILO_NETWORK,
    ]);
    const attached = stdout.trim().split(/\s+/).filter(Boolean);

    // The gateway sidecar doesn't count as a sandbox — it only exists to
    // serve them, so tear it down together with the network once the last
    // sandbox is gone.
    const sandboxes = attached.filter((name) => name !== GATEWAY_CONTAINER);
    if (sandboxes.length > 0) return; // Other sandboxes still attached

    await removeGatewaySidecar();
    await execa("docker", ["network", "rm", SILO_NETWORK]);
    log.info(`Docker network "${SILO_NETWORK}" removed.`);
  } catch {
    // Network may not exist or may still have endpoints — non-fatal
  }
}
