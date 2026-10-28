/**
 * `silo policy` — Manage sandbox egress policies.
 *
 * Subcommands:
 *   silo policy list             — list built-in presets
 *   silo policy show             — print the active policy rules
 *   silo policy apply <preset>   — merge preset rules into the active policy
 *   silo policy remove <preset>  — remove preset rules from the active policy
 *   silo policy add <host>       — add a single host rule
 *   silo policy reload           — send SIGHUP to the proxy daemon to hot-reload
 */
import chalk from "chalk";
import Table from "cli-table3";
import { readConfig, patchConfig } from "../config/manager.js";
import { parsePolicyFile, evaluate } from "../policy/engine.js";
import {
  listPresets,
  getPreset,
  applyPreset,
  removePreset,
  defaultPolicyPath,
  writePolicyFile,
} from "../policy/presets.js";
import { isProxyAlive, readPid } from "../utils/pid.js";
import { log, section } from "../utils/logger.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export function runPolicyList(): void {
  section("Built-in policy presets");
  log.blank();

  const presets = listPresets();
  const table = new Table({
    head: [chalk.bold("Name"), chalk.bold("Description"), chalk.bold("Hosts")],
    style: { head: ["cyan"], border: [] },
    wordWrap: true,
    colWidths: [16, 44, 32],
  });

  for (const preset of presets) {
    table.push([
      chalk.cyan(preset.name),
      preset.description,
      preset.rules.map((r) => chalk.dim(r.host)).join("\n"),
    ]);
  }

  console.log(table.toString());
  log.blank();
  log.info(`Apply a preset: ${chalk.cyan("silo policy apply <name>")}`);
  log.blank();
}

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

export function runPolicyShow(): void {
  const config = readConfig();
  if (!config) {
    log.error("Not configured. Run `silo onboard` first.");
    process.exit(1);
  }

  const policyFile = config.sandbox.policyFile;

  if (!policyFile || !existsSync(resolve(policyFile))) {
    log.info("No policy file configured — using built-in deny-all.");
    log.blank();
    log.info(
      `Apply a preset to create one: ${chalk.cyan("silo policy apply pypi")}`,
    );
    return;
  }

  try {
    const policy = parsePolicyFile(resolve(policyFile));
    section(`Policy: ${policy.name}`);
    log.blank();

    console.log(`  ${chalk.dim("File")}    ${policyFile}`);
    console.log(`  ${chalk.dim("Default")} ${policy.default === "deny" ? chalk.red("deny") : chalk.green("allow")}`);
    log.blank();

    if (policy.rules.length === 0) {
      log.info("No rules — all traffic uses the default action.");
      return;
    }

    const table = new Table({
      head: [chalk.bold("Host pattern"), chalk.bold("Action"), chalk.bold("Comment")],
      style: { head: ["cyan"], border: [] },
    });

    for (const rule of policy.rules) {
      const action =
        rule.action === "allow"
          ? chalk.green("allow")
          : chalk.red("deny");
      table.push([rule.host, action, rule.comment ?? ""]);
    }

    console.log(table.toString());
    log.blank();

    // Quick test
    const testHosts = ["llm.gateway", "api.openai.com", "evil.example.com"];
    section("Policy preview");
    log.blank();
    for (const host of testHosts) {
      const verdict = evaluate(policy, host);
      const label = verdict === "allow" ? chalk.green("✔ allow") : chalk.red("✖ deny");
      console.log(`  ${label}  ${chalk.dim(host)}`);
    }
    log.blank();
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

export function runPolicyApply(presetName: string): void {
  const config = readConfig();
  if (!config) {
    log.error("Not configured. Run `silo onboard` first.");
    process.exit(1);
  }

  const preset = getPreset(presetName);
  if (!preset) {
    log.error(`Unknown preset: "${presetName}"`);
    log.info(`Available: ${listPresets().map((p) => chalk.cyan(p.name)).join(", ")}`);
    process.exit(1);
  }

  try {
    const policyPath = applyPreset(preset, config);

    // Persist the policy file path in config if not already set
    if (!config.sandbox.policyFile) {
      patchConfig({ sandbox: { policyFile: policyPath } });
    }

    log.success(`Preset "${preset.name}" applied → ${chalk.dim(policyPath)}`);
    log.blank();
    log.info(`Added rules:`);
    for (const rule of preset.rules) {
      console.log(`  ${chalk.green("+")} ${rule.host}`);
    }
    log.blank();

    reloadProxyIfRunning();
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

export function runPolicyRemove(presetName: string): void {
  const config = readConfig();
  if (!config) {
    log.error("Not configured. Run `silo onboard` first.");
    process.exit(1);
  }

  const preset = getPreset(presetName);
  if (!preset) {
    log.error(`Unknown preset: "${presetName}"`);
    process.exit(1);
  }

  try {
    const policyPath = removePreset(preset, config);
    log.success(`Preset "${preset.name}" removed from ${chalk.dim(policyPath)}`);
    reloadProxyIfRunning();
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

export function runPolicyAdd(
  host: string,
  opts: { action?: string; comment?: string },
): void {
  const config = readConfig();
  if (!config) {
    log.error("Not configured. Run `silo onboard` first.");
    process.exit(1);
  }

  const action = (opts.action ?? "allow") as "allow" | "deny";
  if (action !== "allow" && action !== "deny") {
    log.error(`Invalid action: "${action}". Must be "allow" or "deny".`);
    process.exit(1);
  }

  const targetPath = resolve(config.sandbox.policyFile ?? defaultPolicyPath());
  let policy: ReturnType<typeof parsePolicyFile>;

  if (existsSync(targetPath)) {
    policy = parsePolicyFile(targetPath);
  } else {
    // Bootstrap with standard preset so first-time users get a working env
    const standardPreset = getPreset("standard");
    policy = {
      version: "1",
      name: "standard",
      description: "Standard developer policy — generated by SILO",
      default: "deny",
      rules: [
        { host: "llm.gateway", action: "allow", comment: "SILO inference proxy" },
        ...(standardPreset?.rules ?? []),
      ],
    };
  }

  // Check if host already exists
  const existing = policy.rules.find((r) => r.host === host);
  if (existing) {
    log.warn(`Host "${host}" already exists in the policy (action: ${existing.action}).`);
    return;
  }

  const newRule = { host, action, ...(opts.comment ? { comment: opts.comment } : {}) };
  policy.rules.push(newRule);

  writePolicyFile(targetPath, policy);

  // Persist the policy file path in config if not already set
  if (!config.sandbox.policyFile) {
    patchConfig({ sandbox: { policyFile: targetPath } });
  }

  log.success(`Added rule: ${chalk.cyan(host)} → ${chalk.green(action)}`);
  log.info(`Policy file: ${chalk.dim(targetPath)}`);

  reloadProxyIfRunning();
}

// ---------------------------------------------------------------------------
// reload
// ---------------------------------------------------------------------------

export async function runPolicyReload(): Promise<void> {
  if (!(await isProxyAlive())) {
    log.warn("Proxy daemon is not running — nothing to reload.");
    log.info(`Start the sandbox first: ${chalk.cyan("silo start")}`);
    return;
  }

  const pid = await readPid();
  if (pid === null) {
    log.warn("Could not read proxy PID.");
    return;
  }

  process.kill(pid, "SIGHUP");
  log.success(`Sent SIGHUP to proxy daemon (pid=${pid}) — policy will hot-reload.`);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function reloadProxyIfRunning(): void {
  readPid()
    .then((pid) => {
      if (pid !== null) {
        try {
          process.kill(pid, "SIGHUP");
          log.info("Policy hot-reloaded in running proxy daemon.");
        } catch {
          // Proxy not running — ignore
        }
      }
    })
    .catch(() => {
      // Non-fatal
    });
}
