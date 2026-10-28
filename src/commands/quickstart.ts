/**
 * `silo quickstart` — Zero-to-sandbox in one command.
 *
 * Combines onboard → build → start → connect into one interactive flow
 * for users who just want to get running fast. Skips steps that are
 * already done (already onboarded, image already built, etc.).
 */
import chalk from "chalk";
import ora from "ora";
import { execa } from "execa";
import { readConfig } from "../config/manager.js";
import { log, printBanner, section } from "../utils/logger.js";
import {
  assertDockerAvailable,
  isContainerRunning,
} from "../utils/system.js";

interface QuickstartOptions {
  framework?: string;
  browser?: boolean;
}

export async function runQuickstart(opts: QuickstartOptions): Promise<void> {
  printBanner();
  section("⚡ Quickstart");
  log.blank();
  log.info("Getting you from zero to sandbox in one go…");
  log.blank();

  // ── Step 1: Docker check ──────────────────────────────────────────────
  const dockerSpinner = ora("Checking Docker…").start();
  try {
    await assertDockerAvailable();
    dockerSpinner.succeed("Docker is available");
  } catch (err) {
    dockerSpinner.fail("Docker is not available");
    log.error("Install Docker Desktop and ensure the daemon is running.");
    process.exit(1);
  }

  // ── Step 2: Onboard if needed ──────────────────────────────────────────
  let config = readConfig();
  if (!config) {
    log.blank();
    section("Step 1 — Initial Setup");
    log.info("No configuration found. Starting onboarding wizard…");
    log.blank();

    const { runOnboard } = await import("./onboard.js");
    await runOnboard({ force: false });

    // Re-read config after onboarding
    config = readConfig();
    if (!config) {
      log.error("Onboarding did not complete. Please run `silo onboard` manually.");
      process.exit(1);
    }
  } else {
    log.info(`${chalk.green("✔")} Already configured (${chalk.dim(config.llm.provider + "/" + config.llm.model)})`);
  }

  // ── Step 3: Build image if needed ──────────────────────────────────────
  log.blank();
  if (opts.browser && !opts.framework) {
    log.error("Browser mode requires a framework image.");
    log.info(`Use ${chalk.cyan("silo quickstart --framework openclaw --browser")}.`);
    process.exit(1);
  }

  const imageTag = opts.framework
    ? `silo-sandbox-${opts.framework}${opts.browser ? "-browser" : ""}:latest`
    : config.sandbox.image;

  let imageExists = false;
  try {
    await execa("docker", ["image", "inspect", imageTag], { stdio: "ignore" });
    imageExists = true;
  } catch {
    imageExists = false;
  }

  if (imageExists) {
    log.info(`${chalk.green("✔")} Image ${chalk.dim(imageTag)} already built`);
  } else {
    section("Step 2 — Building Sandbox Image");
    log.info(`Building ${chalk.cyan(imageTag)}…`);
    log.blank();

    const { runBuild } = await import("./build.js");
    await runBuild({
      noCache: false,
      framework: opts.framework,
      browser: opts.browser,
    });
  }

  // ── Step 4: Start if needed ────────────────────────────────────────────
  log.blank();
  const containerName = config.sandbox.containerName;

  if (await isContainerRunning(containerName)) {
    log.info(`${chalk.green("✔")} Sandbox ${chalk.dim(containerName)} already running`);
  } else {
    section("Step 3 — Launching Sandbox");
    log.blank();

    const { runStart } = await import("./start.js");
    await runStart({
      rebuild: false,
      framework: opts.framework,
      browser: opts.browser,
    });
  }

  // ── Step 5: Connect ────────────────────────────────────────────────────
  log.blank();
  section("Step 4 — Connecting");
  log.info("Opening interactive shell…");
  log.blank();

  const { runConnect } = await import("./connect.js");
  await runConnect({
    shell: "/bin/sh",
    tui: false,
  });
}
