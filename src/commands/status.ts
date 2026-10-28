import chalk from "chalk";
import Table from "cli-table3";
import { readConfig, configPath } from "../config/manager.js";
import { inspectContainer, containerStats } from "../docker/runner.js";
import { log, printBanner, section } from "../utils/logger.js";
import { isContainerRunning, containerExists } from "../utils/system.js";
import { isProxyAlive, readPid, pidFilePath } from "../utils/pid.js";
import { readAuditLog, auditLogPath, getSessionId } from "../audit/audit.js";

// Framework support
import "../frameworks/definitions.js";
import { detectActiveFramework, checkFrameworkHealth } from "../frameworks/lifecycle.js";

export async function runStatus(): Promise<void> {
  printBanner();

  const config = readConfig();
  if (!config) {
    log.warn("SILO is not configured yet.");
    log.info("Run `silo onboard` to get started.");
    return;
  }

  // ── LLM ──────────────────────────────────────────────────────────────────
  section("LLM Configuration");
  const llmTable = new Table({ style: { head: [], border: [] } });
  llmTable.push(
    ["Provider", chalk.cyan(config.llm.provider)],
    ["Model", chalk.cyan(config.llm.model)],
    ["API Key", chalk.dim("••••••••" + config.llm.apiKey.slice(-4))],
    ...(config.llm.baseUrl
      ? [["Base URL", chalk.dim(config.llm.baseUrl)]]
      : []),
  );
  console.log(llmTable.toString());
  log.blank();

  // ── Sandbox ───────────────────────────────────────────────────────────────
  section("Sandbox");
  const { containerName } = config.sandbox;
  const running = await isContainerRunning(containerName);
  const exists = running || (await containerExists(containerName));

  const statusLabel = running
    ? chalk.green("● running")
    : exists
      ? chalk.yellow("● stopped")
      : chalk.dim("○ not created");

  let containerInspect: Record<string, unknown> | undefined;
  if (exists) {
    try {
      containerInspect = await inspectContainer(containerName);
    } catch {
      // Non-fatal — container may vanish while status is rendering.
    }
  }
  const runtimeConfig = containerInspect?.["Config"] as Record<string, unknown> | undefined;
  const image = typeof runtimeConfig?.["Image"] === "string"
    ? runtimeConfig["Image"] as string
    : config.sandbox.image;

  const sandboxTable = new Table({ style: { head: [], border: [] } });
  sandboxTable.push(
    ["Container", containerName],
    ["Status", statusLabel],
    ["Image", image],
    ["Workspace", chalk.dim(config.sandbox.workspacePath)],
    ["CPU limit", config.sandbox.cpuLimit],
    ["Memory limit", config.sandbox.memoryLimit],
  );

  if (running) {
    const stats = await containerStats(containerName);
    sandboxTable.push(
      ["CPU usage", chalk.yellow(stats.cpu)],
      ["Memory usage", chalk.yellow(stats.memory)],
    );

    // Pull uptime from inspect
    if (containerInspect) {
      const state = containerInspect["State"] as Record<string, unknown> | undefined;
      const startedAt = state?.["StartedAt"] as string | undefined;
      if (startedAt) {
        const uptime = humanUptime(new Date(startedAt));
        sandboxTable.push(["Uptime", uptime]);
      }
    }
  }

  console.log(sandboxTable.toString());
  log.blank();

  // ── Framework ─────────────────────────────────────────────────────────────
  if (running) {
    const framework = await detectActiveFramework(containerName);
    if (framework) {
      section(`Framework: ${framework.icon}  ${framework.name}`);
      const fwTable = new Table({ style: { head: [], border: [] } });
      fwTable.push(
        ["ID", chalk.cyan(framework.id)],
        ["Name", framework.name],
        ["Version", framework.version],
        [
          "TUI",
          framework.tuiCommand
            ? chalk.green(framework.tuiCommand)
            : chalk.dim("not available"),
        ],
        [
          "Required policies",
          framework.requiredPolicies.map((p) => chalk.yellow(p)).join(", "),
        ],
      );

      // Run health check
      const health = await checkFrameworkHealth(containerName, framework);
      fwTable.push([
        "Health",
        health.healthy
          ? chalk.green(`● healthy — ${health.output}`)
          : chalk.red(`● unhealthy — ${health.output}`),
      ]);

      console.log(fwTable.toString());
      log.blank();
    }
  }

  // ── Policy ────────────────────────────────────────────────────────────────
  section("Policy");
  const policyTable = new Table({ style: { head: [], border: [] } });
  policyTable.push([
    "Active policy",
    config.sandbox.policyFile
      ? chalk.cyan(config.sandbox.policyFile)
      : chalk.dim("default (deny-all egress)"),
  ]);
  console.log(policyTable.toString());
  log.blank();

  // ── Integrations ──────────────────────────────────────────────────────────
  section("Integrations");
  const integrations = config.integrations ?? [];
  if (integrations.length === 0) {
    console.log(chalk.dim("  No integrations configured."));
    log.info(`Add one with ${chalk.cyan("silo integrations add <service>")}`);
  } else {
    const intTable = new Table({
      head: [
        chalk.bold("Name"),
        chalk.bold("Gateway"),
        chalk.bold("Base URL"),
        chalk.bold("Auth"),
      ],
      style: { head: [], border: [] },
    });
    for (const i of integrations) {
      intTable.push([
        chalk.cyan(i.name),
        i.gateway,
        chalk.dim(i.baseUrl),
        i.authType,
      ]);
    }
    console.log(intTable.toString());
  }
  log.blank();

  // ── Proxy ────────────────────────────────────────────────────────────────
  section("Inference Proxy");
  const proxyAlive = await isProxyAlive();
  const proxyPid = await readPid();
  const proxyTable = new Table({ style: { head: [], border: [] } });
  proxyTable.push(
    ["Port", String(config.proxy.port)],
    [
      "Status",
      proxyAlive ? chalk.green("● running") : chalk.dim("○ stopped"),
    ],
    ["PID", proxyAlive && proxyPid ? String(proxyPid) : chalk.dim("—")],
    ["PID file", chalk.dim(pidFilePath())],
  );
  console.log(proxyTable.toString());
  log.blank();

  // ── Audit ─────────────────────────────────────────────────────────────────
  section("Audit");
  const sessionId = getSessionId();
  const auditEntries = await readAuditLog({ sessionId });
  const llmEntries = auditEntries.filter((e) => e.category === "llm");
  const blockedEntries = auditEntries.filter((e) => e.category === "blocked");

  const auditTable = new Table({ style: { head: [], border: [] } });
  auditTable.push(
    ["Session", chalk.dim(sessionId.slice(0, 8) + "…")],
    ["Total requests", chalk.cyan(String(auditEntries.filter((e) => e.method !== "INTERNAL").length))],
    ["LLM requests", chalk.cyan(String(llmEntries.length))],
    ["Blocked requests", blockedEntries.length > 0 ? chalk.red(String(blockedEntries.length)) : chalk.dim("0")],
    ["Audit log", chalk.dim(auditLogPath())],
  );
  console.log(auditTable.toString());
  log.blank();

  // ── Meta ─────────────────────────────────────────────────────────────────────
  section("Meta");
  const metaTable = new Table({ style: { head: [], border: [] } });
  metaTable.push(
    ["Config file", chalk.dim(configPath())],
    [
      "Onboarded",
      config.onboardedAt
        ? chalk.dim(new Date(config.onboardedAt).toLocaleString())
        : chalk.dim("—"),
    ],
  );
  console.log(metaTable.toString());
  log.blank();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function humanUptime(since: Date): string {
  const seconds = Math.floor((Date.now() - since.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}
