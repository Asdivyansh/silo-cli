/**
 * `silo list` — List all running SILO agent containers.
 *
 * Uses Docker labels to discover silo-managed containers, then displays
 * a summary table with name, status, image, uptime, and resource usage.
 */
import chalk from "chalk";
import Table from "cli-table3";
import { execa } from "execa";
import { log, printBanner, section } from "../utils/logger.js";
import { assertDockerAvailable } from "../utils/system.js";


export async function runList(): Promise<void> {
  printBanner();
  await assertDockerAvailable();

  section("Running Agents");

  try {
    const { stdout } = await execa("docker", [
      "ps",
      "--filter", "label=managed-by=silo",
      "--format", "{{.Names}}\t{{.Status}}\t{{.Image}}\t{{.RunningFor}}\t{{.Ports}}",
    ]);

    const lines = stdout.trim().split("\n").filter(Boolean);

    if (lines.length === 0) {
      log.blank();
      log.info("No running agents.");
      log.info(`Start one with: ${chalk.cyan("silo start")} or ${chalk.cyan("silo start --name my-agent")}`);
      log.blank();
      return;
    }

    const table = new Table({
      head: [
        chalk.bold("Name"),
        chalk.bold("Status"),
        chalk.bold("Image"),
        chalk.bold("Uptime"),
      ],
      style: { head: ["cyan"], border: [] },
    });

    for (const line of lines) {
      const [name = "", status = "", image = "", uptime = ""] = line.split("\t");
      const statusLabel = status.startsWith("Up")
        ? chalk.green("● running")
        : chalk.yellow("● " + status.toLowerCase());

      table.push([chalk.cyan(name), statusLabel, chalk.dim(image), uptime]);
    }

    log.blank();
    console.log(table.toString());
    log.blank();
    log.info(`Total: ${chalk.cyan(String(lines.length))} agent(s)`);
    log.blank();
  } catch (err) {
    log.error(`Failed to list agents: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
