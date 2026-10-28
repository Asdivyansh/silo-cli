/**
 * `silo build` — Build the agent sandbox Docker image.
 *
 * Uses the Dockerfile in the `sandbox/` directory adjacent to this package.
 * The build context is the same directory so entrypoint.sh is included.
 *
 * Framework support:
 *   silo build                           → base sandbox image
 *   silo build --framework crewai        → silo-sandbox-crewai:latest
 *   silo build --framework crewai --browser → silo-sandbox-crewai-browser:latest
 *   silo build --all-frameworks          → builds images for all frameworks
 */
import ora from "ora";
import chalk from "chalk";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { readConfig } from "../config/manager.js";
import { log } from "../utils/logger.js";
import { assertDockerAvailable } from "../utils/system.js";

// Import framework support
import "../frameworks/definitions.js";
import {
  getFramework,
  listFrameworks,
  frameworkImageTag,
} from "../frameworks/registry.js";
import { prepareFrameworkBuildContext } from "../frameworks/docker-builder.js";

/** Resolve the `sandbox/` directory relative to the package root. */
function resolveSandboxDir(): string {
  // In the built bundle, __dirname is dist/ so we go up one level.
  // In dev (tsx), it is src/commands/ so we go up two levels.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "sandbox"),     // dist/  → sandbox/
    join(here, "..", "..", "sandbox"), // src/commands/ → sandbox/
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "Dockerfile"))) return candidate;
  }
  throw new Error(
    `Cannot locate sandbox/Dockerfile. Expected it next to the dist/ or src/ directory.\n` +
    `Tried:\n${candidates.map((c) => `  ${c}`).join("\n")}`,
  );
}

interface BuildOptions {
  tag?: string;
  noCache: boolean;
  framework?: string;
  allFrameworks?: boolean;
  browser?: boolean;
}

export async function runBuild(opts: BuildOptions): Promise<void> {
  await assertDockerAvailable();

  let sandboxDir: string;
  try {
    sandboxDir = resolveSandboxDir();
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // ── Build all framework images ──────────────────────────────────────────
  if (opts.allFrameworks) {
    await buildAllFrameworks(sandboxDir, opts);
    return;
  }

  // ── Build a specific framework image ────────────────────────────────────
  if (opts.framework) {
    await buildFrameworkImage(opts.framework, sandboxDir, opts);
    return;
  }

  // ── Build the base sandbox image ────────────────────────────────────────
  if (opts.browser) {
    log.error("Browser mode is only available for framework images.");
    log.info(`Use ${chalk.cyan("silo build --framework openclaw --browser")} or ${chalk.cyan("silo build --all-frameworks --browser")}.`);
    process.exit(1);
  }

  const config = readConfig();
  const imageTag = opts.tag ?? config?.sandbox.image ?? "silo-sandbox:latest";

  const dockerfilePath = join(sandboxDir, "Dockerfile");
  log.info(`Building image ${chalk.cyan(imageTag)}`);
  log.info(`Dockerfile:    ${chalk.dim(dockerfilePath)}`);
  log.blank();

  const args = [
    "build",
    "--file", dockerfilePath,
    "--tag", imageTag,
    ...(opts.noCache ? ["--no-cache"] : []),
    sandboxDir,
  ];

  const spinner = ora("Building sandbox image (this may take a minute)…").start();
  spinner.stop(); // Let Docker stream output directly

  try {
    await execa("docker", args, { stdio: "inherit" });
    log.blank();
    log.success(`Image ${chalk.cyan(imageTag)} built successfully.`);
    log.blank();
    log.info(`Start the sandbox with: ${chalk.cyan("silo start")}`);
  } catch (err) {
    log.blank();
    log.error("Build failed.");
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Framework-specific builds
// ---------------------------------------------------------------------------

async function buildFrameworkImage(
  frameworkId: string,
  sandboxDir: string,
  opts: BuildOptions,
): Promise<void> {
  const framework = getFramework(frameworkId);
  if (!framework) {
    log.error(`Unknown framework: "${frameworkId}"`);
    log.info(
      `Run ${chalk.cyan("silo frameworks")} to see supported frameworks.`,
    );
    process.exit(1);
  }

  const imageTag = opts.tag ?? frameworkImageTag(framework.id, { browser: opts.browser });

  log.info(`${framework.icon}  Building ${chalk.cyan(framework.name)} sandbox image${opts.browser ? chalk.cyan(" + browser") : ""}`);
  log.info(`Image tag:  ${chalk.dim(imageTag)}`);
  log.info(`Install:    ${chalk.dim(framework.install.method)} — ${chalk.dim(framework.install.packages.join(", ") || "custom")}`);
  if (opts.browser) {
    log.info(`Browser:    ${chalk.dim("Chromium baked into image; browser runfiles mounted as tmpfs at start")}`);
  }
  log.blank();

  // Generate framework-specific Dockerfile and build context
  const { dockerfilePath, contextDir } = prepareFrameworkBuildContext(
    framework,
    sandboxDir,
    { browser: opts.browser },
  );

  log.info(`Dockerfile: ${chalk.dim(dockerfilePath)}`);
  log.blank();

  const args = [
    "build",
    "--file", dockerfilePath,
    "--tag", imageTag,
    ...(opts.noCache ? ["--no-cache"] : []),
    contextDir,
  ];

  try {
    await execa("docker", args, { stdio: "inherit" });
    log.blank();
    log.success(`${framework.icon}  ${chalk.cyan(framework.name)} image built: ${imageTag}`);
    log.blank();
    log.info(`Start with: ${chalk.cyan(`silo start --framework ${framework.id}${opts.browser ? " --browser" : ""}`)}`);
  } catch (err) {
    log.blank();
    log.error(`Failed to build ${framework.name} image.`);
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

async function buildAllFrameworks(
  sandboxDir: string,
  opts: BuildOptions,
): Promise<void> {
  const frameworks = listFrameworks();
  log.info(`Building images for ${chalk.cyan(String(frameworks.length))} frameworks…`);
  log.blank();

  let succeeded = 0;
  let failed = 0;

  for (const fw of frameworks) {
    const imageTag = frameworkImageTag(fw.id, { browser: opts.browser });
    const spinner = ora(`${fw.icon}  Building ${fw.name}${opts.browser ? " + browser" : ""} (${imageTag})…`).start();

    try {
      const { dockerfilePath, contextDir } = prepareFrameworkBuildContext(
        fw,
        sandboxDir,
        { browser: opts.browser },
      );

      await execa("docker", [
        "build",
        "--file", dockerfilePath,
        "--tag", imageTag,
        ...(opts.noCache ? ["--no-cache"] : []),
        contextDir,
      ]);

      spinner.succeed(`${fw.icon}  ${fw.name} → ${chalk.dim(imageTag)}`);
      succeeded++;
    } catch (err) {
      spinner.fail(`${fw.icon}  ${fw.name} failed: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }

  log.blank();
  log.success(`Built ${succeeded}/${frameworks.length} framework images.`);
  if (failed > 0) {
    log.warn(`${failed} build(s) failed.`);
  }
  log.blank();
}
