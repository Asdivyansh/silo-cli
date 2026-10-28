/**
 * `silo frameworks` — List all supported agent frameworks.
 *
 * Shows a formatted table of every framework SILO can orchestrate,
 * with install status, TUI availability, and quick-start commands.
 */
import chalk from "chalk";
import Table from "cli-table3";
import { execa } from "execa";
import { log, printBanner, section } from "../utils/logger.js";

// Import definitions to populate the registry
import "../frameworks/definitions.js";
import {
  listFrameworks,
  getFramework,
  frameworkImageTag,
} from "../frameworks/registry.js";
import type { FrameworkDefinition } from "../frameworks/registry.js";

// ---------------------------------------------------------------------------
// silo frameworks (list all)
// ---------------------------------------------------------------------------

export async function runFrameworksList(): Promise<void> {
  printBanner();
  section("Supported Agent Frameworks");
  log.blank();

  const frameworks = listFrameworks();

  const table = new Table({
    head: [
      chalk.bold(""),
      chalk.bold("Framework"),
      chalk.bold("Description"),
      chalk.bold("TUI"),
      chalk.bold("Image Built"),
    ],
    style: { head: [], border: [] },
    colWidths: [5, 16, 50, 7, 14],
    wordWrap: true,
  });

  for (const fw of frameworks) {
    const imageExists = await isImageBuilt(fw);
    table.push([
      fw.icon,
      chalk.cyan(fw.id),
      fw.description,
      fw.tuiCommand ? chalk.green("Yes") : chalk.dim("No"),
      imageExists ? chalk.green("✔") : chalk.dim("—"),
    ]);
  }

  console.log(table.toString());
  log.blank();

  console.log(chalk.dim("  Quick start:"));
  console.log(
    `    ${chalk.cyan("silo build --framework crewai")}     Build the framework image`,
  );
  console.log(
    `    ${chalk.cyan("silo start --framework crewai")}     Launch sandbox with CrewAI active`,
  );
  console.log(
    `    ${chalk.cyan("silo connect --tui")}                Open the framework's TUI`,
  );
  console.log(
    `    ${chalk.cyan("silo frameworks info crewai")}       Detailed framework info`,
  );
  log.blank();
}

// ---------------------------------------------------------------------------
// silo frameworks info <id>
// ---------------------------------------------------------------------------

export async function runFrameworksInfo(id: string): Promise<void> {
  printBanner();

  // Ensure definitions are loaded
  await import("../frameworks/definitions.js");

  const fw = getFramework(id);
  if (!fw) {
    log.error(`Unknown framework: "${id}"`);
    log.info(
      `Run ${chalk.cyan("silo frameworks")} to see all supported frameworks.`,
    );
    process.exit(1);
  }

  section(`${fw.icon}  ${fw.name}`);
  log.blank();

  const table = new Table({ style: { head: [], border: [] } });

  table.push(
    ["ID", chalk.cyan(fw.id)],
    ["Name", fw.name],
    ["Description", fw.description],
    ["Version", fw.version],
    ["Install method", fw.install.method],
    [
      "Packages",
      fw.install.packages.length > 0
        ? fw.install.packages.join(", ")
        : chalk.dim("(custom install)"),
    ],
    [
      "System deps",
      fw.install.systemDeps?.join(", ") ?? chalk.dim("none"),
    ],
    [
      "Required policies",
      fw.requiredPolicies.length > 0
        ? fw.requiredPolicies.map((p) => chalk.yellow(p)).join(", ")
        : chalk.dim("none"),
    ],
    [
      "TUI command",
      fw.tuiCommand ? chalk.green(fw.tuiCommand) : chalk.dim("not available"),
    ],
    ["Health check", chalk.dim(fw.healthCheck)],
    ["Tags", fw.tags.map((t) => chalk.dim(`#${t}`)).join(" ")],
    ["Docs", chalk.underline(fw.docsUrl)],
  );

  if (fw.envVars && Object.keys(fw.envVars).length > 0) {
    table.push([
      "Env vars",
      Object.entries(fw.envVars)
        .map(([k, v]) => `${k}=${v}`)
        .join(", "),
    ]);
  }

  if (fw.extraPolicyRules && fw.extraPolicyRules.length > 0) {
    table.push([
      "Extra policies",
      fw.extraPolicyRules.map((r) => `${r.host} (${r.comment})`).join(", "),
    ]);
  }

  const imageTag = frameworkImageTag(fw.id);
  const imageBuilt = await isImageBuilt(fw);
  table.push([
    "Image",
    imageBuilt
      ? chalk.green(`${imageTag} (built)`)
      : chalk.dim(`${imageTag} (not built)`),
  ]);

  console.log(table.toString());
  log.blank();

  if (!imageBuilt) {
    log.info(
      `Build the image first: ${chalk.cyan(`silo build --framework ${fw.id}`)}`,
    );
  } else {
    log.info(
      `Start with: ${chalk.cyan(`silo start --framework ${fw.id}`)}`,
    );
  }
  log.blank();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function isImageBuilt(fw: FrameworkDefinition): Promise<boolean> {
  const tag = frameworkImageTag(fw.id);
  try {
    await execa("docker", ["image", "inspect", tag], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
