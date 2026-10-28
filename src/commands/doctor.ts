/**
 * `silo doctor` — Diagnostic health check.
 *
 * Runs a comprehensive check of the entire SILO stack and reports
 * issues with actionable fix suggestions. Designed for first-time
 * users who hit problems and experienced users debugging issues.
 *
 * Checks:
 *   1. Docker availability + version
 *   2. SILO configuration
 *   3. Sandbox image built
 *   4. Framework images
 *   5. Container running
 *   6. Proxy daemon alive
 *   7. Policy file exists + valid
 *   8. Network bridge exists
 *   9. Framework health (if active)
 */
import chalk from "chalk";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execa } from "execa";
import { readConfig, configPath } from "../config/manager.js";
import { log, printBanner, section } from "../utils/logger.js";
import { isContainerRunning, containerExists } from "../utils/system.js";
import { isProxyAlive, readPid } from "../utils/pid.js";
import { proxyLogPath } from "../proxy/spawn.js";
import { SILO_NETWORK } from "../docker/templates.js";
import { GATEWAY_CONTAINER, needsGatewaySidecar } from "../docker/gateway.js";

// Framework support
import "../frameworks/definitions.js";
import { listFrameworks, frameworkImageTag } from "../frameworks/registry.js";
import { detectActiveFramework, checkFrameworkHealth } from "../frameworks/lifecycle.js";

interface CheckResult {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
  fix?: string;
}

export async function runDoctor(): Promise<void> {
  printBanner();
  section("SILO Doctor");
  log.blank();
  log.info(chalk.dim("Running diagnostic checks…"));
  log.blank();

  const results: CheckResult[] = [];

  // ── 1. Docker ──────────────────────────────────────────────────────────
  try {
    const { stdout } = await execa("docker", ["version", "--format", "{{.Server.Version}}"]);
    results.push({
      name: "Docker Engine",
      status: "pass",
      message: `v${stdout.trim()}`,
    });
  } catch {
    results.push({
      name: "Docker Engine",
      status: "fail",
      message: "Docker is not running or not installed",
      fix: "Install Docker Desktop from https://docker.com or start the Docker daemon",
    });
  }

  // ── 2. Configuration ──────────────────────────────────────────────────
  const config = readConfig();
  if (config) {
    results.push({
      name: "Configuration",
      status: "pass",
      message: `${configPath()}`,
    });

    // Validate API key is present
    if (config.llm.apiKey && config.llm.apiKey.length > 4) {
      results.push({
        name: "LLM API Key",
        status: "pass",
        message: `${config.llm.provider} (••••${config.llm.apiKey.slice(-4)})`,
      });
    } else {
      results.push({
        name: "LLM API Key",
        status: "warn",
        message: "API key looks empty or very short",
        fix: "Re-run `silo onboard` to set a valid API key",
      });
    }
  } else {
    results.push({
      name: "Configuration",
      status: "fail",
      message: "Not configured",
      fix: "Run `silo onboard` to set up SILO",
    });
    // Can't check more without config
    printResults(results);
    return;
  }

  // ── 3. Base sandbox image ─────────────────────────────────────────────
  try {
    await execa("docker", ["image", "inspect", config.sandbox.image], {
      stdio: "ignore",
    });
    results.push({
      name: "Base Image",
      status: "pass",
      message: config.sandbox.image,
    });
  } catch {
    results.push({
      name: "Base Image",
      status: "fail",
      message: `"${config.sandbox.image}" not found`,
      fix: "Run `silo build` to build the base sandbox image",
    });
  }

  // ── 4. Framework images ───────────────────────────────────────────────
  const frameworks = listFrameworks();
  let builtCount = 0;
  for (const fw of frameworks) {
    try {
      await execa("docker", ["image", "inspect", frameworkImageTag(fw.id)], {
        stdio: "ignore",
      });
      builtCount++;
    } catch {
      // Not built — that's fine, just count
    }
  }
  results.push({
    name: "Framework Images",
    status: builtCount > 0 ? "pass" : "warn",
    message: `${builtCount}/${frameworks.length} built`,
    ...(builtCount === 0
      ? { fix: "Run `silo build --framework crewai` to build a framework image" }
      : {}),
  });

  // ── 5. Docker network ─────────────────────────────────────────────────
  try {
    await execa("docker", ["network", "inspect", SILO_NETWORK], {
      stdio: "ignore",
    });
    results.push({
      name: "Docker Network",
      status: "pass",
      message: `"${SILO_NETWORK}" bridge exists`,
    });
  } catch {
    results.push({
      name: "Docker Network",
      status: "warn",
      message: `"${SILO_NETWORK}" not created yet`,
      fix: "Network is auto-created on `silo start`",
    });
  }

  // ── 5b. Egress gateway sidecar (Docker Desktop only) ──────────────────
  if (needsGatewaySidecar()) {
    const gw = await execa(
      "docker",
      ["inspect", "--format", "{{.State.Running}}", GATEWAY_CONTAINER],
      { reject: false },
    );
    const gwRunning = gw.exitCode === 0 && gw.stdout.trim() === "true";
    results.push({
      name: "Egress Gateway Sidecar",
      status: gwRunning ? "pass" : "warn",
      message: gwRunning
        ? `"${GATEWAY_CONTAINER}" is running`
        : `"${GATEWAY_CONTAINER}" is not running — sandboxes cannot reach the proxy without it`,
      ...(gwRunning ? {} : { fix: "Run `silo start` to recreate the gateway sidecar" }),
    });
  }

  // ── 6. Container ──────────────────────────────────────────────────────
  const containerName = config.sandbox.containerName;
  const isRunning = await isContainerRunning(containerName);
  const exists = isRunning || (await containerExists(containerName));

  if (isRunning) {
    results.push({
      name: "Sandbox Container",
      status: "pass",
      message: `"${containerName}" is running`,
    });

    // ── 6a. Framework health ──────────────────────────────────────────
    const framework = await detectActiveFramework(containerName);
    if (framework) {
      const health = await checkFrameworkHealth(containerName, framework);
      results.push({
        name: `Framework: ${framework.name}`,
        status: health.healthy ? "pass" : "warn",
        message: health.healthy ? health.output : `Unhealthy: ${health.output}`,
        ...(health.healthy ? {} : { fix: `Check framework install inside container` }),
      });
    }

    // ── 6b. Proxy reachability check ──────────────────────────────────
    try {
      const reachability = await execa("docker", [
        "exec",
        containerName,
        "curl",
        "-s",
        "-o", "/dev/null",
        "-w", "%{http_code}",
        `http://llm.gateway:${config.proxy.port}/_silo/health`
      ], { reject: false });

      const httpStatus = reachability.stdout.trim();
      if (httpStatus === "200") {
        results.push({
          name: "In-Sandbox Proxy Reachability",
          status: "pass",
          message: `Reachable from container at http://llm.gateway:${config.proxy.port}`,
        });
      } else {
        const platformMsg = process.platform === "linux"
          ? "This usually means host firewall (e.g. firewalld, ufw) or iptables rules are blocking the --internal bridge network traffic to the host."
          : `This usually means the egress gateway sidecar ("${GATEWAY_CONTAINER}") is not running or not attached to "${SILO_NETWORK}" — re-run: silo start.`;
        results.push({
          name: "In-Sandbox Proxy Reachability",
          status: "fail",
          message: `Unreachable (HTTP ${httpStatus || "failed"}).`,
          fix: `${platformMsg} Try running: silo status`,
        });
      }
    } catch (err) {
      results.push({
        name: "In-Sandbox Proxy Reachability",
        status: "fail",
        message: `Error executing reachability check: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  } else if (exists) {
    results.push({
      name: "Sandbox Container",
      status: "warn",
      message: `"${containerName}" exists but is stopped`,
      fix: "Run `silo start` to launch it",
    });
  } else {
    results.push({
      name: "Sandbox Container",
      status: "warn",
      message: "No container running",
      fix: "Run `silo start` to launch the sandbox",
    });
  }

  // ── 7. Proxy daemon ───────────────────────────────────────────────────
  const proxyAlive = await isProxyAlive();
  const proxyPid = await readPid();

  if (proxyAlive) {
    results.push({
      name: "Inference Proxy",
      status: "pass",
      message: `Running on :${config.proxy.port} (pid=${proxyPid})`,
    });
  } else {
    const lastError = readLastDaemonError();
    results.push({
      name: "Inference Proxy",
      status: isRunning ? "fail" : "warn",
      message: lastError ? `Not running. Last daemon error: ${lastError}` : "Not running",
      fix: isRunning
        ? `Proxy should be running when sandbox is active. Try \`silo stop && silo start\`; full log: ${proxyLogPath()}`
        : "Proxy auto-starts with `silo start`",
    });
  }

  // ── 7b. Proxy daemon log ────────────────────────────────────────────────
  if (existsSync(proxyLogPath())) {
    const recentErrors = readRecentDaemonErrorCount();
    results.push({
      name: "Proxy Daemon Log",
      status: recentErrors > 0 ? "warn" : "pass",
      message:
        recentErrors > 0
          ? `${recentErrors} error line(s) in the last 200 — inspect: ${proxyLogPath()}`
          : proxyLogPath(),
    });
  }

  // ── 8. Policy file ────────────────────────────────────────────────────
  const policyFile = config.sandbox.policyFile;
  if (policyFile) {
    const absPath = resolve(policyFile);
    if (existsSync(absPath)) {
      try {
        const { parsePolicyFile } = await import("../policy/engine.js");
        const policy = parsePolicyFile(absPath);
        results.push({
          name: "Policy File",
          status: "pass",
          message: `"${policy.name}" — ${policy.rules.length} rules (default: ${policy.default})`,
        });
      } catch (err) {
        results.push({
          name: "Policy File",
          status: "fail",
          message: `Invalid YAML: ${err instanceof Error ? err.message : String(err)}`,
          fix: `Fix the policy file at ${absPath} or re-create with \`silo policy apply standard\``,
        });
      }
    } else {
      results.push({
        name: "Policy File",
        status: "warn",
        message: `Configured but file missing: ${absPath}`,
        fix: "Run `silo policy apply standard` to re-create the default policy",
      });
    }
  } else {
    results.push({
      name: "Policy File",
      status: "warn",
      message: "No policy file configured — using built-in deny-all",
      fix: "Run `silo policy apply standard` for a developer-friendly default",
    });
  }

  // ── 9. Workspace ──────────────────────────────────────────────────────
  if (existsSync(config.sandbox.workspacePath)) {
    results.push({
      name: "Workspace",
      status: "pass",
      message: config.sandbox.workspacePath,
    });
  } else {
    results.push({
      name: "Workspace",
      status: "warn",
      message: `Directory does not exist: ${config.sandbox.workspacePath}`,
      fix: `Create it with: mkdir -p "${config.sandbox.workspacePath}"`,
    });
  }

  printResults(results);
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function printResults(results: CheckResult[]): void {
  const icons = {
    pass: chalk.green("✔"),
    warn: chalk.yellow("⚠"),
    fail: chalk.red("✖"),
  };

  for (const r of results) {
    console.log(`  ${icons[r.status]}  ${chalk.bold(r.name)}: ${r.message}`);
    if (r.fix) {
      console.log(`     ${chalk.dim("→")} ${chalk.dim(r.fix)}`);
    }
  }

  log.blank();

  const passCount = results.filter((r) => r.status === "pass").length;
  const warnCount = results.filter((r) => r.status === "warn").length;
  const failCount = results.filter((r) => r.status === "fail").length;

  if (failCount > 0) {
    log.error(
      `${failCount} critical issue(s) found. Fix them to use SILO.`,
    );
  } else if (warnCount > 0) {
    log.warn(`${passCount} passed, ${warnCount} warning(s). SILO is mostly ready.`);
  } else {
    log.success(`All ${passCount} checks passed. SILO is ready!`);
  }
  log.blank();
}

// ---------------------------------------------------------------------------
// Daemon log helpers
// ---------------------------------------------------------------------------

/** Read the tail of the proxy daemon log; empty array if unreadable. */
function readDaemonLogTail(maxLines: number): string[] {
  try {
    const content = readFileSync(proxyLogPath(), "utf8");
    return content.split("\n").filter(Boolean).slice(-maxLines);
  } catch {
    return [];
  }
}

/** The most recent [ERROR] line from the daemon log, truncated for display. */
function readLastDaemonError(): string | null {
  const lines = readDaemonLogTail(200);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.includes("[ERROR]")) {
      const line = lines[i]!;
      return line.length > 160 ? `${line.slice(0, 160)}…` : line;
    }
  }
  return null;
}

/** Count [ERROR] lines among the last 200 daemon log lines. */
function readRecentDaemonErrorCount(): number {
  return readDaemonLogTail(200).filter((l) => l.includes("[ERROR]")).length;
}
