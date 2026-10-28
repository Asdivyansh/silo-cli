import ora from "ora";
import chalk from "chalk";
import { execa } from "execa";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readConfig, patchConfig } from "../config/manager.js";
import { startContainer } from "../docker/runner.js";
import { SILO_NETWORK } from "../docker/templates.js";
import { ensureGatewaySidecar, needsGatewaySidecar } from "../docker/gateway.js";
import { log, printBanner } from "../utils/logger.js";
import {
  assertDockerAvailable,
  isContainerRunning,
  containerExists,
} from "../utils/system.js";

// Framework support
import "../frameworks/definitions.js";
import {
  getFramework,
  isValidFramework,
  frameworkImageTag,
} from "../frameworks/registry.js";
import type { FrameworkDefinition } from "../frameworks/registry.js";
import type { HostMount, IntegrationConfig } from "../config/schema.js";
import { applyPreset, getPreset } from "../policy/presets.js";

interface StartOptions {
  policy?: string;
  rebuild: boolean;
  name?: string;
  workspace?: string;
  desktop?: boolean;
  browser?: boolean;
  mount?: string[];
  framework?: string;
  logs?: boolean;
}

const BROWSER_MIN_MEMORY_LIMIT = "2g";

export async function runStart(opts: StartOptions): Promise<void> {
  printBanner();

  const config = readConfig();
  if (!config) {
    log.error("No configuration found. Run `silo onboard` first.");
    process.exit(1);
  }

  await assertDockerAvailable();

  // ── Resolve framework ───────────────────────────────────────────────────
  let framework: FrameworkDefinition | undefined;
  if (opts.framework) {
    if (!isValidFramework(opts.framework)) {
      log.error(`Unknown framework: "${opts.framework}"`);
      log.info(
        `Run ${chalk.cyan("silo frameworks")} to see supported frameworks.`,
      );
      process.exit(1);
    }
    framework = getFramework(opts.framework);
  }

  if (opts.browser && !framework) {
    log.error("Browser mode requires a framework image.");
    log.info(
      `Use ${chalk.cyan("silo start --framework openclaw --browser")} after building with ` +
        chalk.cyan("silo build --framework openclaw --browser"),
    );
    process.exit(1);
  }

  // Derive container name from --name flag
  const containerName = opts.name ? `silo-${opts.name}` : config.sandbox.containerName;

  let hostMounts: HostMount[];
  try {
    hostMounts = resolveHostMounts(opts, config.sandbox.hostMounts ?? []);
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // ── Guard: already running ───────────────────────────────────────────────
  if (await isContainerRunning(containerName)) {
    log.warn(`Sandbox "${containerName}" is already running.`);
    log.info(`Run ${chalk.cyan("silo connect")} to open a shell inside it.`);
    return;
  }

  // ── Remove stale stopped container ──────────────────────────────────────
  if (await containerExists(containerName)) {
    const cleanSpinner = ora(`Removing stale container "${containerName}"…`).start();
    try {
      await execa("docker", ["rm", "--force", containerName]);
      cleanSpinner.succeed("Stale container removed");
    } catch (err) {
      cleanSpinner.fail("Failed to remove stale container");
      log.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }

  // ── Resolve image ───────────────────────────────────────────────────────
  let image = config.sandbox.image;
  if (framework) {
    image = frameworkImageTag(framework.id, { browser: opts.browser });

    // Check if the framework image exists
    try {
      await execa("docker", ["image", "inspect", image], { stdio: "ignore" });
    } catch {
      log.error(
        `Framework image "${image}" not found. Build it first:`,
      );
      log.info(`  ${chalk.cyan(`silo build --framework ${framework.id}${opts.browser ? " --browser" : ""}`)}`);
      process.exit(1);
    }
  }

  const browserMemory = opts.browser
    ? ensureBrowserMemoryLimit(config.sandbox.memoryLimit)
    : { memoryLimit: config.sandbox.memoryLimit, bumped: false };

  // ── Apply overrides ──────────────────────────────────────────────────────
  const effectiveSandbox = {
    ...config.sandbox,
    containerName,
    image,
    memoryLimit: browserMemory.memoryLimit,
    ...(opts.workspace ? { workspacePath: opts.workspace } : {}),
    ...(opts.policy ? { policyFile: opts.policy } : {}),
    ...(hostMounts.length > 0 ? { hostMounts } : {}),
    ...(framework ? { activeFramework: framework.id } : {}),
  };
  const effectiveConfig = { ...config, sandbox: effectiveSandbox };

  // ── Auto-apply framework policies ───────────────────────────────────────
  if (framework) {
    log.info(`${framework.icon}  Framework: ${chalk.cyan(framework.name)}`);

    for (const presetName of framework.requiredPolicies) {
      const preset = getPreset(presetName);
      if (preset) {
        try {
          applyPreset(preset, effectiveConfig);
          log.info(`  Policy: ${chalk.green("+")} ${presetName}`);
        } catch {
          log.warn(`  Could not auto-apply policy preset: ${presetName}`);
        }
      }
    }

    // Apply extra framework-specific rules
    if (framework.extraPolicyRules && framework.extraPolicyRules.length > 0) {
      for (const rule of framework.extraPolicyRules) {
        log.info(`  Policy: ${chalk.green("+")} ${rule.host} (${rule.comment})`);
      }
    }

    log.blank();
  }

  log.info(`Agent:     ${chalk.dim(containerName)}`);
  log.info(`Workspace: ${chalk.dim(effectiveSandbox.workspacePath)}`);
  if (opts.browser) {
    log.info(`Browser:   ${chalk.dim("enabled (Chromium inside sandbox)")}`);
    log.info(`Memory:    ${chalk.dim(effectiveSandbox.memoryLimit)}${browserMemory.bumped ? chalk.dim(` (auto-raised for browser mode from ${config.sandbox.memoryLimit})`) : ""}`);
  }
  if (hostMounts.length > 0) {
    log.warn("Host mounts expose local files to the sandboxed agent. Only mount paths you are comfortable sharing.");
    for (const mount of hostMounts) {
      log.info(`Host mount: ${chalk.dim(`${mount.source} → ${mount.target}:${mount.mode}`)}`);
    }
  }
  log.info(`Image:     ${chalk.dim(image)}`);
  log.info(`Policy:    ${chalk.dim(effectiveSandbox.policyFile ?? "default (deny-all)")}`);
  log.blank();

  // ── Ensure Docker bridge network + egress gateway exist ──────────────────
  await ensureSiloNetwork();
  await ensureEgressGateway(config.proxy.port, effectiveConfig.integrations ?? []);

  // ── Start inference proxy daemon ─────────────────────────────────────────
  await ensureProxyDaemon(config.proxy.port);

  // ── Start sandbox container ──────────────────────────────────────────────
  const sandboxSpinner = ora("Starting agent sandbox…").start();
  try {
    const containerId = await startContainer(
      effectiveSandbox,
      effectiveConfig.proxy,
      effectiveConfig.integrations ?? [],
      framework
          ? {
            id: framework.id,
            envVars: framework.envVars,
            tmpfsMounts: framework.tmpfsMounts,
            tmpfsMountSizes: framework.tmpfsMountSizes,
            browser: opts.browser,
          }
        : undefined,
    );
    sandboxSpinner.succeed(
      `Sandbox started (${chalk.dim(containerId.slice(0, 12))})`,
    );

    // Persist proxy.running=true and active framework
    patchConfig({
      proxy: { port: config.proxy.port, running: true, autoOpenLogs: config.proxy.autoOpenLogs },
      sandbox: { activeFramework: framework?.id },
    });

    log.blank();
    log.success(`Agent sandbox "${containerName}" is running.`);
    log.blank();

    if (opts.logs !== false && config.proxy.autoOpenLogs !== false) {
      const { spawnLogsTerminal } = await import("../utils/terminal.js");
      await spawnLogsTerminal();
    }

    if (framework) {
      const lines = [
        chalk.dim("  Commands:"),
        `    ${chalk.cyan("silo connect")}          — open an interactive shell`,
      ];

      if (framework.tuiCommand) {
        lines.push(
          `    ${chalk.cyan("silo connect --tui")}    — launch ${framework.name} TUI`,
        );
      }

      lines.push(
        `    ${chalk.cyan("silo status")}           — view sandbox + framework health`,
        `    ${chalk.cyan("silo snapshot create")}   — save sandbox state`,
        `    ${chalk.cyan("silo stop")}             — shut down the sandbox`,
      );

      console.log(lines.join("\n"));
    } else {
      console.log(
        [
          chalk.dim("  Commands:"),
          `    ${chalk.cyan("silo connect")}          — open an interactive shell`,
          `    ${chalk.cyan("silo status")}           — view resource usage`,
          `    ${chalk.cyan("silo policy apply pypi")} — allow pip installs`,
          `    ${chalk.cyan("silo stop")}             — shut down the sandbox`,
        ].join("\n"),
      );
    }
    log.blank();
  } catch (err) {
    sandboxSpinner.fail("Failed to start sandbox");
    const msg = err instanceof Error ? err.message : String(err);
    log.error(msg);

    if (msg.includes("image") && msg.includes("not found")) {
      if (framework) {
        log.info(
          `Framework image not found. Build it with: ${chalk.cyan(`silo build --framework ${framework.id}${opts.browser ? " --browser" : ""}`)}`,
        );
      } else {
        log.info(
          `Sandbox image "${config.sandbox.image}" not found locally.\n` +
            `  Build it with: ${chalk.cyan("silo build")}`,
        );
      }
    }
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Network helpers
// ---------------------------------------------------------------------------

async function ensureSiloNetwork(): Promise<void> {
  const spinner = ora(`Ensuring Docker network "${SILO_NETWORK}"…`).start();

  try {
    // Check if the network already exists
    const { stdout } = await execa("docker", [
      "network", "inspect",
      "--format", "{{.Internal}}",
      SILO_NETWORK,
    ]);
    const isInternal = stdout.trim() === "true";

    // The sandbox network must be --internal on every platform. Recreate
    // legacy networks from versions that used a standard bridge on Docker
    // Desktop (the gateway sidecar now provides the proxy route instead).
    const needsRecreate = !isInternal;

    if (needsRecreate) {
      spinner.text = `Reconfiguring Docker network "${SILO_NETWORK}"…`;
      try {
        await execa("docker", ["network", "rm", SILO_NETWORK]);
      } catch {
        try {
          // If removal fails, find attached containers and disconnect them
          const inspectResult = await execa("docker", [
            "network",
            "inspect",
            "--format",
            "{{range .Containers}}{{.Name}} {{end}}",
            SILO_NETWORK,
          ]);
          const containers = inspectResult.stdout.trim().split(/\s+/).filter(Boolean);
          for (const container of containers) {
            await execa("docker", ["network", "disconnect", "-f", SILO_NETWORK, container]);
          }
          // Retry network removal
          await execa("docker", ["network", "rm", SILO_NETWORK]);
        } catch (err) {
          spinner.fail(`Failed to recreate Docker network "${SILO_NETWORK}": network is in use.`);
          throw new Error(
            `Docker network "${SILO_NETWORK}" is currently in use. ` +
              `Please stop all containers first using \`silo stop --all\` and try again.`
          );
        }
      }
      // Force fallthrough to creation logic
      throw new Error("recreate");
    }

    spinner.succeed(`Docker network "${SILO_NETWORK}" already exists`);
  } catch {
    // Create the internal bridge network for sandbox containers. Sandboxes
    // get no direct internet route; the proxy is reached via host-gateway
    // (Linux) or the silo-gateway sidecar (Docker Desktop).
    try {
      await execa("docker", [
        "network", "create",
        "--driver", "bridge",
        "--internal",
        "--label", "managed-by=silo",
        SILO_NETWORK,
      ]);
      spinner.succeed(`Docker network "${SILO_NETWORK}" created (internal bridge)`);
    } catch (err) {
      spinner.fail(`Failed to create Docker network "${SILO_NETWORK}"`);
      throw err;
    }
  }
}

/**
 * On Docker Desktop, start the socat sidecar that bridges the internal
 * sandbox network to the host-side proxy. Without it, sandboxes on
 * macOS/Windows would have no route to llm.gateway at all.
 */
async function ensureEgressGateway(
  proxyPort: number,
  integrations: IntegrationConfig[],
): Promise<void> {
  if (!needsGatewaySidecar()) return;

  const spinner = ora("Starting egress gateway sidecar…").start();
  try {
    await ensureGatewaySidecar(proxyPort, integrations);
    spinner.succeed("Egress gateway ready — sandbox traffic routes only through the proxy");
  } catch (err) {
    spinner.fail("Failed to start egress gateway sidecar");
    log.info(
      `The sidecar image (alpine/socat) may need to be pulled — check Docker connectivity and re-run ${chalk.cyan("silo start")}.`,
    );
    throw err;
  }
}

function resolveHostMounts(opts: StartOptions, configuredMounts: HostMount[]): HostMount[] {
  const mounts = [...configuredMounts];

  if (opts.desktop) {
    const desktopPath = join(homedir(), "Desktop");
    if (!existsSync(desktopPath)) {
      throw new Error(`Desktop path does not exist: ${desktopPath}`);
    }
    mounts.push({ source: desktopPath, target: "/host/Desktop", mode: "rw" });
  }

  for (const spec of opts.mount ?? []) {
    mounts.push(parseHostMountSpec(spec));
  }

  return mounts;
}

function parseHostMountSpec(spec: string): HostMount {
  const parts = spec.split(":");
  if (parts.length < 2) {
    throw new Error(
      `Invalid --mount value "${spec}". Use hostPath:/host/name[:ro|rw].`,
    );
  }

  const maybeMode = parts[parts.length - 1];
  const hasMode = maybeMode === "ro" || maybeMode === "rw";
  const mode = hasMode ? maybeMode : "rw";
  const target = hasMode ? parts[parts.length - 2] : parts[parts.length - 1];
  const sourceParts = hasMode ? parts.slice(0, -2) : parts.slice(0, -1);
  const rawSource = sourceParts.join(":");

  if (!rawSource || !target) {
    throw new Error(
      `Invalid --mount value "${spec}". Use hostPath:/host/name[:ro|rw].`,
    );
  }

  if (target !== "/host" && !target.startsWith("/host/")) {
    throw new Error(
      `Invalid --mount target "${target}". Additional host mounts must target /host/...`,
    );
  }

  const source = expandHostPath(rawSource);
  if (!existsSync(source)) {
    throw new Error(`Host mount source does not exist: ${source}`);
  }

  return { source, target, mode };
}

function expandHostPath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

export function ensureBrowserMemoryLimit(memoryLimit: string): {
  memoryLimit: string;
  bumped: boolean;
} {
  const currentMiB = parseMemoryToMiB(memoryLimit);
  const minimumMiB = parseMemoryToMiB(BROWSER_MIN_MEMORY_LIMIT)!;

  if (currentMiB === null) {
    log.warn(
      `Could not parse memory limit "${memoryLimit}". Browser mode usually needs at least ${BROWSER_MIN_MEMORY_LIMIT}.`,
    );
    return { memoryLimit, bumped: false };
  }

  if (currentMiB < minimumMiB) {
    return { memoryLimit: BROWSER_MIN_MEMORY_LIMIT, bumped: true };
  }

  return { memoryLimit, bumped: false };
}

export function parseMemoryToMiB(value: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*([kmgt]?i?b?|[kmgt])?$/i.exec(value.trim());
  if (!match) return null;

  const amount = Number(match[1]);
  const unit = (match[2] ?? "b").toLowerCase();
  if (!Number.isFinite(amount)) return null;

  switch (unit) {
    case "b":
    case "":
      return amount / (1024 * 1024);
    case "k":
    case "kb":
    case "ki":
    case "kib":
      return amount / 1024;
    case "m":
    case "mb":
    case "mi":
    case "mib":
      return amount;
    case "g":
    case "gb":
    case "gi":
    case "gib":
      return amount * 1024;
    case "t":
    case "tb":
    case "ti":
    case "tib":
      return amount * 1024 * 1024;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Proxy daemon helpers
// ---------------------------------------------------------------------------

async function ensureProxyDaemon(port: number): Promise<void> {
  const { isProxyAlive } = await import("../utils/pid.js");

  if (await isProxyAlive()) {
    log.info(`Inference proxy already running on :${port}`);
    return;
  }

  const spinner = ora(`Starting inference proxy on :${port}…`).start();

  const { spawnProxyDaemon } = await import("../proxy/spawn.js");
  await spawnProxyDaemon(port);

  if (await isProxyAlive()) {
    spinner.succeed(`Inference proxy running on :${port}`);
  } else {
    spinner.warn(`Inference proxy spawned — verify with \`silo status\``);
  }
}
