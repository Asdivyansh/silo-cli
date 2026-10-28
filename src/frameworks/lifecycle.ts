/**
 * Framework Lifecycle Management
 *
 * Health checks, port forwarding, and container-level framework status
 * queries. Used by `silo status`, `silo connect --tui`, and the
 * auto-recovery logic.
 */
import { execa } from "execa";
import type { FrameworkDefinition } from "./registry.js";
import { getFramework } from "./registry.js";
import { log } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Health checks
// ---------------------------------------------------------------------------

export interface FrameworkHealthResult {
  frameworkId: string;
  healthy: boolean;
  output: string;
  checkedAt: string;
}

/**
 * Run a framework's health check command inside the container.
 * Returns a structured result — never throws.
 */
export async function checkFrameworkHealth(
  containerName: string,
  framework: FrameworkDefinition,
): Promise<FrameworkHealthResult> {
  try {
    const result = await execa(
      "docker",
      [
        "exec",
        "--workdir", "/workspace",
        containerName,
        "/bin/sh", "-c",
        framework.healthCheck,
      ],
      { timeout: 15_000, reject: false },
    );

    return {
      frameworkId: framework.id,
      healthy: result.exitCode === 0,
      output: (result.stdout || result.stderr).trim(),
      checkedAt: new Date().toISOString(),
    };
  } catch (err) {
    return {
      frameworkId: framework.id,
      healthy: false,
      output: err instanceof Error ? err.message : String(err),
      checkedAt: new Date().toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// TUI launching
// ---------------------------------------------------------------------------

/**
 * Launch a framework's TUI inside the container.
 * Replaces the current process stdio (interactive).
 *
 * @throws If the framework has no TUI or the container is not running.
 */
export async function launchFrameworkTui(
  containerName: string,
  framework: FrameworkDefinition,
): Promise<void> {
  if (!framework.tuiCommand) {
    throw new Error(
      `${framework.name} does not provide a TUI. ` +
      `Use 'silo connect' for a shell instead.`,
    );
  }

  await assertRuntimeRequirements(containerName, framework);

  log.info(`Launching ${framework.name} TUI: ${framework.tuiCommand}`);

  // Some frameworks (e.g. OpenClaw) need a background daemon started first
  if (framework.prelaunchCommand) {
    log.info(`Starting ${framework.name} background service…`);
    try {
      await execa(
        "docker",
        [
          "exec", "-d",
          "--workdir", "/workspace",
          containerName,
          "/bin/sh", "-c",
          framework.prelaunchCommand,
        ],
      );
      // Give the daemon a moment to bind its port
      if (framework.id === "openclaw") {
        const maxAttempts = 20;
        let ready = false;
        const portCheckCommand = `node -e "const net=require('node:net'); const s=net.connect(18789,'127.0.0.1'); s.on('connect',()=>process.exit(0)); s.on('error',()=>process.exit(1)); setTimeout(()=>process.exit(1),200);"`;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          const check = await execa(
            "docker",
            [
              "exec",
              containerName,
              "/bin/sh", "-c",
              portCheckCommand,
            ],
            { reject: false }
          );
          if (check.exitCode === 0) {
            ready = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        if (!ready) {
          log.warn(`OpenClaw gateway did not bind to port 18789 in time — TUI may fail to connect.`);
        }
      } else {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    } catch {
      log.warn(`Could not start ${framework.name} background service — TUI may not connect.`);
    }
  }

  await execa(
    "docker",
    [
      "exec", "-it",
      "--workdir", "/workspace",
      containerName,
      "/bin/sh", "-c",
      framework.tuiCommand,
    ],
    { stdio: "inherit" },
  );
}

// ---------------------------------------------------------------------------
// Runtime requirement checks
// ---------------------------------------------------------------------------

export function satisfiesVersionRequirement(
  currentVersion: string,
  requirement: string,
): boolean {
  const current = parseVersion(currentVersion);
  const required = parseVersion(requirement.replace(/^>=\s*/, ""));
  if (!current || !required) return false;

  if (current.major !== required.major) return current.major > required.major;
  if (current.minor !== required.minor) return current.minor > required.minor;
  return current.patch >= required.patch;
}

async function assertRuntimeRequirements(
  containerName: string,
  framework: FrameworkDefinition,
): Promise<void> {
  const requiredNode = framework.runtimeRequirements?.node;
  if (!requiredNode) return;

  const result = await execa(
    "docker",
    ["exec", containerName, "node", "--version"],
    { reject: false },
  );
  const current = (result.stdout || result.stderr).trim();

  if (result.exitCode === 0 && satisfiesVersionRequirement(current, requiredNode)) {
    return;
  }

  const min = requiredNode.replace(/^>=\s*/, "");
  const found = current || "Node.js is not installed";
  throw new Error(
    [
      `${framework.name} requires Node.js ${min}+ inside the sandbox, but this container has ${found}.`,
      "",
      "This usually means the framework image was built before SILO's Node 22 runtime update.",
      "Rebuild and restart the sandbox:",
      `  silo stop`,
      `  silo build --framework ${framework.id} --no-cache`,
      `  silo start --framework ${framework.id}`,
      `  silo connect --tui`,
      "",
      "If you use browser mode, add --browser to both build and start.",
    ].join("\n"),
  );
}

function parseVersion(value: string): { major: number; minor: number; patch: number } | null {
  const match = /v?(\d+)\.(\d+)\.(\d+)/.exec(value);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

// ---------------------------------------------------------------------------
// Framework detection from running container
// ---------------------------------------------------------------------------

/**
 * Detect which framework is active in a container by reading the
 * SILO_FRAMEWORK label set during `silo start --framework`.
 * Returns null if no framework is active (plain sandbox).
 */
export async function detectActiveFramework(
  containerName: string,
): Promise<FrameworkDefinition | null> {
  try {
    const { stdout } = await execa("docker", [
      "inspect",
      "--format",
      "{{index .Config.Labels \"silo.framework\"}}",
      containerName,
    ]);

    const frameworkId = stdout.trim();
    if (!frameworkId || frameworkId === "<no value>") return null;

    // Ensure definitions are loaded
    await import("./definitions.js");
    return getFramework(frameworkId) ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Port forwarding for web UIs
// ---------------------------------------------------------------------------

/**
 * Get the list of ports that need forwarding for a framework's web UI.
 * Returns an empty array for frameworks without web UIs.
 */
export function getFrameworkPorts(framework: FrameworkDefinition): number[] {
  return framework.ports ?? [];
}
