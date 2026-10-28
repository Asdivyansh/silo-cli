import chalk from "chalk";
import { readConfig } from "../config/manager.js";
import { log } from "../utils/logger.js";
import { assertDockerAvailable, isContainerRunning } from "../utils/system.js";
import { ensureProxyRunning } from "../utils/health.js";

// Framework support
import "../frameworks/definitions.js";
import { detectActiveFramework } from "../frameworks/lifecycle.js";
import { launchFrameworkTui } from "../frameworks/lifecycle.js";

interface ConnectOptions {
  shell: string;
  name?: string;
  tui?: boolean;
  logs?: boolean;
}

export async function runConnect(opts: ConnectOptions): Promise<void> {
  const config = readConfig();
  if (!config) {
    log.error("No configuration found. Run `silo onboard` first.");
    process.exit(1);
  }

  await assertDockerAvailable();

  const containerName = opts.name ? `silo-${opts.name}` : config.sandbox.containerName;

  if (!(await isContainerRunning(containerName))) {
    log.error(`Sandbox "${containerName}" is not running.`);
    log.info(`Start it first with ${chalk.cyan("silo start")}.`);
    process.exit(1);
  }

  // Auto-restart proxy if it crashed
  await ensureProxyRunning(config);

  const { startPromptListener } = await import("../utils/prompt-listener.js");
  const promptListener = startPromptListener(config.proxy.port);



  try {
    // ── TUI mode ────────────────────────────────────────────────────────────
    if (opts.tui) {
      const framework = await detectActiveFramework(containerName);
      if (!framework) {
        log.warn("No agent framework is active in this sandbox.");
        log.info(
          `Start with a framework: ${chalk.cyan("silo start --framework crewai")}`,
        );
        log.info("Falling back to interactive shell…");
        log.blank();
      } else if (!framework.tuiCommand) {
        log.warn(
          `${framework.icon}  ${framework.name} does not provide a TUI.`,
        );
        log.info("Falling back to interactive shell…");
        log.blank();
      } else {
        log.info(
          `${framework.icon}  Preparing ${chalk.cyan(framework.name)} TUI…`,
        );
        log.blank();

        try {
          await launchFrameworkTui(containerName, framework);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException & { exitCode?: number }).exitCode;
          if (code !== undefined && code !== 0 && code !== 130) {
            log.error(`TUI exited with code ${code}.`);
          } else if (code === undefined) {
            log.error(err instanceof Error ? err.message : String(err));
          }
        }

        log.blank();
        log.info("Disconnected from TUI.");
        return;
      }
    }

    // ── Shell mode (default) ────────────────────────────────────────────────
    // Show framework hint if one is active
    const framework = await detectActiveFramework(containerName);
    if (framework) {
      log.info(
        `${framework.icon}  Framework: ${chalk.cyan(framework.name)}`,
      );
      if (framework.tuiCommand) {
        log.info(
          `   TUI available: ${chalk.cyan(`silo connect --tui`)} or run ${chalk.dim(framework.tuiCommand)} inside the shell`,
        );
      }
    }

    log.info(
      `Connecting to ${chalk.cyan(containerName)} (shell: ${chalk.dim(opts.shell)})…`,
    );
    log.info(chalk.dim('Type "exit" or press Ctrl-D to leave the sandbox.'));
    log.blank();

    try {
      // Replace current process stdio with the container's shell
      const { execa } = await import("execa");
      await execa("docker", ["exec", "-it", containerName, opts.shell], {
        stdio: "inherit",
      });
    } catch (err) {
      // Exit code 130 = Ctrl-C — normal termination, don't print an error
      const code = (err as NodeJS.ErrnoException & { exitCode?: number }).exitCode;
      if (code !== undefined && code !== 0 && code !== 130) {
        log.error(`Shell exited with code ${code}.`);
      }
    }

    log.blank();
    log.info("Disconnected from sandbox.");
  } finally {
    promptListener.stop();
  }
}
