/**
 * `silo snapshot` — Sandbox Snapshot & Rollback
 *
 * Create named snapshots of running sandbox containers and roll back
 * to previous states. Uses `docker commit` for snapshots and
 * `docker run` with the snapshot image for rollbacks.
 *
 * Commands:
 *   silo snapshot create <name>   — snapshot the current sandbox state
 *   silo snapshot list            — list all snapshots
 *   silo snapshot rollback <name> — restore a snapshot
 *   silo snapshot delete <name>   — delete a snapshot
 */
import ora from "ora";
import chalk from "chalk";
import Table from "cli-table3";
import { execa } from "execa";
import { readConfig } from "../config/manager.js";
import { log, printBanner, section } from "../utils/logger.js";
import {
  assertDockerAvailable,
  isContainerRunning,
  containerExists,
} from "../utils/system.js";
import { stopContainer } from "../docker/runner.js";

// Snapshot image naming: silo-snapshot-<container>-<name>:<timestamp>
function snapshotImageName(containerName: string, name: string): string {
  return `silo-snapshot-${containerName}-${name}:latest`;
}

// ---------------------------------------------------------------------------
// silo snapshot create <name>
// ---------------------------------------------------------------------------

export async function runSnapshotCreate(
  name: string,
  opts: { name?: string } = {},
): Promise<void> {
  printBanner();

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

  // Validate snapshot name
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
    log.error("Snapshot name must be lowercase alphanumeric with hyphens/underscores.");
    process.exit(1);
  }

  const imageTag = snapshotImageName(containerName, name);
  const spinner = ora(`Creating snapshot "${name}" from ${containerName}…`).start();

  try {
    await execa("docker", [
      "commit",
      "--message", `SILO snapshot: ${name}`,
      "--change", `LABEL silo.snapshot.name=${name}`,
      "--change", `LABEL silo.snapshot.source=${containerName}`,
      "--change", `LABEL silo.snapshot.created=${new Date().toISOString()}`,
      containerName,
      imageTag,
    ]);

    spinner.succeed(`Snapshot "${chalk.cyan(name)}" created.`);
    log.info(`Image: ${chalk.dim(imageTag)}`);
    log.blank();
    log.info(
      `Rollback with: ${chalk.cyan(`silo snapshot rollback ${name}`)}`,
    );
  } catch (err) {
    spinner.fail("Failed to create snapshot");
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// silo snapshot list
// ---------------------------------------------------------------------------

export async function runSnapshotList(): Promise<void> {
  printBanner();
  await assertDockerAvailable();
  section("Sandbox Snapshots");
  log.blank();

  try {
    const { stdout } = await execa("docker", [
      "images",
      "--filter", "label=silo.snapshot.name",
      "--format", "{{.Repository}}:{{.Tag}}\t{{.Size}}\t{{.CreatedAt}}\t{{index .Labels \"silo.snapshot.name\"}}\t{{index .Labels \"silo.snapshot.source\"}}",
    ]);

    const lines = stdout.trim().split("\n").filter(Boolean);

    if (lines.length === 0) {
      console.log(chalk.dim("  No snapshots found."));
      log.blank();
      log.info(
        `Create one with: ${chalk.cyan("silo snapshot create <name>")}`,
      );
      return;
    }

    const table = new Table({
      head: [
        chalk.bold("Name"),
        chalk.bold("Source"),
        chalk.bold("Size"),
        chalk.bold("Created"),
        chalk.bold("Image"),
      ],
      style: { head: [], border: [] },
    });

    for (const line of lines) {
      const [image, size, created, snapshotName, source] = line.split("\t");
      table.push([
        chalk.cyan(snapshotName ?? "—"),
        source ?? "—",
        size ?? "—",
        created ?? "—",
        chalk.dim(image ?? "—"),
      ]);
    }

    console.log(table.toString());
  } catch {
    console.log(chalk.dim("  Could not list snapshots. Is Docker running?"));
  }

  log.blank();
}

// ---------------------------------------------------------------------------
// silo snapshot rollback <name>
// ---------------------------------------------------------------------------

export async function runSnapshotRollback(
  snapshotName: string,
  opts: { name?: string } = {},
): Promise<void> {
  printBanner();

  const config = readConfig();
  if (!config) {
    log.error("No configuration found. Run `silo onboard` first.");
    process.exit(1);
  }

  await assertDockerAvailable();

  const containerName = opts.name ? `silo-${opts.name}` : config.sandbox.containerName;

  // Find the snapshot image
  const imageTag = snapshotImageName(containerName, snapshotName);
  try {
    await execa("docker", ["image", "inspect", imageTag], { stdio: "ignore" });
  } catch {
    log.error(`Snapshot "${snapshotName}" not found for container "${containerName}".`);
    log.info(`Run ${chalk.cyan("silo snapshot list")} to see available snapshots.`);
    process.exit(1);
  }

  // Stop the current container if running
  if (await containerExists(containerName)) {
    const spinner = ora(`Stopping current sandbox "${containerName}"…`).start();
    try {
      await stopContainer(containerName);
      spinner.succeed("Current sandbox stopped.");
    } catch (err) {
      spinner.fail("Failed to stop current sandbox");
      log.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }

  // Start a new container from the snapshot image
  const spinner = ora(`Rolling back to snapshot "${snapshotName}"…`).start();
  try {
    // Use the same run flags but with the snapshot image
    const { buildRunFlags } = await import("../docker/templates.js");
    const effectiveSandbox = { ...config.sandbox, image: imageTag };
    const flags = buildRunFlags(effectiveSandbox, config.proxy, config.integrations);

    await execa("docker", ["run", ...flags]);
    spinner.succeed(
      `Rolled back to snapshot "${chalk.cyan(snapshotName)}".`,
    );
    log.blank();
    log.success(`Sandbox "${containerName}" is running from snapshot.`);
    log.info(`Connect with: ${chalk.cyan("silo connect")}`);
  } catch (err) {
    spinner.fail("Rollback failed");
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  log.blank();
}

// ---------------------------------------------------------------------------
// silo snapshot delete <name>
// ---------------------------------------------------------------------------

export async function runSnapshotDelete(
  snapshotName: string,
  opts: { name?: string } = {},
): Promise<void> {
  printBanner();

  const config = readConfig();
  if (!config) {
    log.error("No configuration found. Run `silo onboard` first.");
    process.exit(1);
  }

  await assertDockerAvailable();

  const containerName = opts.name ? `silo-${opts.name}` : config.sandbox.containerName;
  const imageTag = snapshotImageName(containerName, snapshotName);

  const spinner = ora(`Deleting snapshot "${snapshotName}"…`).start();
  try {
    await execa("docker", ["rmi", imageTag]);
    spinner.succeed(`Snapshot "${chalk.cyan(snapshotName)}" deleted.`);
  } catch {
    spinner.fail(`Snapshot "${snapshotName}" not found or could not be deleted.`);
  }

  log.blank();
}
