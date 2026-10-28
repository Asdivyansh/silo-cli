import inquirer from "inquirer";
import ora from "ora";
import chalk from "chalk";
import gradient from "gradient-string";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir, platform, arch, release } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { writeConfig, readConfig } from "../config/manager.js";
import type { SiloConfig, LLMProvider } from "../config/schema.js";
import { log, section } from "../utils/logger.js";
import { assertDockerAvailable } from "../utils/system.js";
import {
  defaultPolicyPath,
  writePolicyFile,
  applyPreset,
  getPreset,
} from "../policy/presets.js";
import type { Policy } from "../policy/engine.js";

// Default models per provider
const DEFAULT_MODELS: Record<LLMProvider, string> = {
  openai: "gpt-4o",
  anthropic: "claude-sonnet-4-6",
  local: "llama3",
};

// API key env-var hints per provider
const API_KEY_HINTS: Record<LLMProvider, string> = {
  openai: "Starts with sk-…",
  anthropic: "Starts with sk-ant-…",
  local: "Enter any non-empty string (e.g. 'local')",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runBirdAnimation(): Promise<void> {
  // If not an interactive terminal or in a test suite, bypass animation & wait entirely
  if (!process.stdin.isTTY || process.env["NODE_ENV"] === "test" || process.env["VITEST"]) {
    return;
  }

  const width = 55;
  const height = 4;

  // Parallax layers of birds with horizontal wrapping period
  const birds = [
    { x: -4, y: 1.0, state: 0, speedX: 1.2, color: chalk.cyanBright.bold },
    { x: -9, y: 1.8, state: 1, speedX: 1.2, color: chalk.blueBright },
    { x: -14, y: 0.8, state: 2, speedX: 1.2, color: chalk.blueBright },
    { x: -19, y: 1.5, state: 1, speedX: 1.2, color: chalk.magenta.dim },
  ];

  // Stars with different twinkling phases
  const stars = [
    { r: 0, c: 8, phase: 0 },
    { r: 2, c: 24, phase: 2 },
    { r: 1, c: 48, phase: 1 },
    { r: 0, c: 35, phase: 3 },
  ];

  const mountains = "  /\\_/\\          /\\_/\\          /\\_/\\          /\\_/\\";

  console.log(`  ${chalk.green.bold("Press [Enter] to start configuration...")} ${chalk.dim("(or Ctrl+C to exit)")}`);
  console.log();

  // Print empty lines for the 4-line animation container
  for (let i = 0; i < height; i++) {
    console.log();
  }

  // Setup raw stdin keypress listener
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  let keepRunning = true;
  let frame = 0;

  const onData = (key: Buffer) => {
    const str = key.toString();
    if (str === "\u0003" || str === "\u0004") {
      process.exit(0);
    }
    keepRunning = false;
  };
  process.stdin.on("data", onData);

  const period = width + 25;

  while (keepRunning) {
    // 1. Initialize screen buffer
    const buffer: string[][] = Array.from({ length: height }, () =>
      Array.from({ length: width }, () => " ")
    );

    // 2. Draw stars (twinkling based on frame index)
    for (const s of stars) {
      const index = (frame + s.phase) % 4;
      const char = [".", "*", "·", " "][index]!;
      if (char !== " ") {
        buffer[s.r]![s.c] = chalk.dim.yellow(char);
      }
    }

    // 3. Draw crescent moon
    if (buffer[0] && buffer[0][42] !== undefined) {
      buffer[0][42] = chalk.yellow("☾");
    }

    // 4. Update and draw birds
    for (const bird of birds) {
      bird.x += bird.speedX;
      bird.state = (bird.state + 1) % 3;

      // Wrap birds around to keep the flock soaring infinitely
      const px = Math.round(((bird.x + 20) % period) - 20);
      const py = Math.round(bird.y);

      // Render bird parts
      if (py >= 0 && py < height - 1) {
        let leftWing = "─";
        let rightWing = "─";
        if (bird.state === 0) {
          leftWing = "\\";
          rightWing = "/";
        } else if (bird.state === 2) {
          leftWing = "/";
          rightWing = "\\";
        }

        const cols = [px - 1, px, px + 1];
        const chars = [leftWing, "v", rightWing];

        for (let i = 0; i < 3; i++) {
          const col = cols[i]!;
          if (col >= 0 && col < width) {
            buffer[py]![col] = bird.color(chars[i]!);
          }
        }
      }
    }

    // 5. Draw mountain range at the bottom row (row 3)
    for (let c = 0; c < width; c++) {
      const char = mountains[c] || " ";
      if (char !== " ") {
        buffer[height - 1]![c] = chalk.hex("#475569")(char);
      }
    }

    // 6. Move cursor back up and overwrite the visual block
    process.stdout.write(`\x1b[${height}A`);

    for (let r = 0; r < height; r++) {
      const lineText = buffer[r]!.join("");
      process.stdout.write(`\r\x1b[K  ${lineText}\n`);
    }

    frame++;
    await sleep(50);
  }

  // Cleanup stdin listener and raw mode
  process.stdin.removeListener("data", onData);
  process.stdin.setRawMode(false);
  process.stdin.pause();
}

async function animateWelcome(): Promise<void> {
  const LOGO = [
    "   _____  ____  __    ____  ",
    "  / ___/ /  _/ / /   / __ \\ ",
    "  \\__ \\  / /  / /   / / / / ",
    " ___/ / _/ /  / /___/ /_/ /  ",
    "/____/ /___/ /_____/\\____/   "
  ];

  console.clear();
  console.log();

  // Vibrant Indigo to Cyan gradient for modern developer tool aesthetics
  const grad = gradient(["#6366f1", "#06b6d4"]);

  for (const line of LOGO) {
    console.log("  " + grad(line));
    await sleep(25); // quick, elegant line-by-line render
  }

  console.log();
  console.log(`  ${chalk.bold.white("SILO")} ${chalk.cyan("v0.2.0")} ${chalk.dim("•")} ${chalk.white("Secure AI Agent Sandbox")}`);
  console.log();

  // Play Star Wars style hyperspace jump animation under the logo
  await runBirdAnimation();

  // Clear screen and redraw clean logo + sys info when starting configuration
  console.clear();
  console.log();
  for (const line of LOGO) {
    console.log("  " + grad(line));
  }
  console.log();
  console.log(`  ${chalk.bold.white("SILO")} ${chalk.cyan("v0.2.0")} ${chalk.dim("•")} ${chalk.white("Secure AI Agent Sandbox")}`);
  console.log();

  const os = `${platform()} ${arch()} (${release()})`;
  const nodeVer = process.version;
  let dockerVer = "unknown";
  try {
    dockerVer = execSync("docker --version", { encoding: "utf8" })
      .replace(/Docker version\s*/i, "")
      .replace(/,\s*build.*/, "")
      .trim();
  } catch { /* ignore */ }

  console.log(chalk.dim("  System Info:"));
  console.log(`    ${chalk.dim("OS:")}      ${chalk.white(os)}`);
  console.log(`    ${chalk.dim("Node:")}    ${chalk.white(nodeVer)}`);
  console.log(`    ${chalk.dim("Docker:")}  ${chalk.white(dockerVer)}`);
  console.log();

  console.log(`  ${chalk.cyan("Starting configuration wizard...")}`);
  console.log();
}

export async function runOnboard(opts: { force: boolean }): Promise<void> {
  await animateWelcome();

  // Warn if already configured unless --force
  const existing = readConfig();
  if (existing && !opts.force) {
    log.warn("SILO is already configured. Run with --force to overwrite.");
    log.info(`Config location: ${chalk.dim("run `silo status` to see the path")}`);
    return;
  }

  // Pre-flight checks
  const spinner = ora("Checking prerequisites…").start();
  await assertDockerAvailable();
  spinner.succeed("Docker is available");

  log.blank();
  section("Step 1 — LLM Provider");

  const { provider } = await inquirer.prompt<{ provider: LLMProvider }>([
    {
      type: "list",
      name: "provider",
      message: "Which LLM provider will the agent use?",
      choices: [
        { name: "OpenAI (GPT-4o, GPT-4-turbo, …)", value: "openai" },
        { name: "Anthropic (Claude Sonnet/Opus, …)", value: "anthropic" },
        { name: "Local / Custom (Ollama, LM Studio, …)", value: "local" },
      ],
    },
  ]);

  let baseUrl: string | undefined;
  if (provider === "local") {
    const { url } = await inquirer.prompt<{ url: string }>([
      {
        type: "input",
        name: "url",
        message: "Base URL of your local inference server:",
        default: "http://localhost:11434",
        validate: (v: string) => {
          try {
            new URL(v);
            return true;
          } catch {
            return "Enter a valid URL (e.g. http://localhost:11434)";
          }
        },
      },
    ]);
    baseUrl = url;
  }

  log.blank();
  section("Step 2 — API Key");
  log.info(chalk.dim(API_KEY_HINTS[provider as keyof typeof API_KEY_HINTS]));

  const { apiKey } = await inquirer.prompt<{ apiKey: string }>([
    {
      type: "password",
      name: "apiKey",
      message: `${provider} API key:`,
      mask: "*",
      validate: (v: string) =>
        v.trim().length > 0 ? true : "API key cannot be empty.",
    },
  ]);

  log.blank();
  section("Step 3 — Model");

  const { model } = await inquirer.prompt<{ model: string }>([
    {
      type: "input",
      name: "model",
      message: "Model name:",
      default: DEFAULT_MODELS[provider as keyof typeof DEFAULT_MODELS],
      validate: (v: string) =>
        v.trim().length > 0 ? true : "Model name cannot be empty.",
    },
  ]);

  log.blank();
  section("Step 4 — Workspace");

  const defaultWorkspace = join(homedir(), "silo-workspace");
  const { workspacePath } = await inquirer.prompt<{ workspacePath: string }>([
    {
      type: "input",
      name: "workspacePath",
      message: "Host path to mount as /workspace inside the container:",
      default: defaultWorkspace,
      validate: (v: string) =>
        v.trim().length > 0 ? true : "Path cannot be empty.",
    },
  ]);

  log.blank();
  section("Step 5 — Resource Limits");

  const { cpuLimit, memoryLimit } = await inquirer.prompt<{
    cpuLimit: string;
    memoryLimit: string;
  }>([
    {
      type: "input",
      name: "cpuLimit",
      message: "CPU limit (e.g. 1.0 = one core):",
      default: "1.0",
      validate: (v: string) =>
        /^\d+(\.\d+)?$/.test(v) ? true : "Enter a number like 0.5 or 2.0",
    },
    {
      type: "input",
      name: "memoryLimit",
      message: "Memory limit (e.g. 512m, 1g):",
      default: "512m",
      validate: (v: string) =>
        /^\d+[mg]$/i.test(v) ? true : "Use format like 512m or 1g",
    },
  ]);

  log.blank();
  section("Step 6 — Security Policy");
  log.info(
    chalk.dim(
      "Controls how SILO handles outbound network requests from the sandbox.",
    ),
  );

  const { securityMode } = await inquirer.prompt<{ securityMode: "strict" | "audit" }>([
    {
      type: "list",
      name: "securityMode",
      message: "Choose a default security policy:",
      choices: [
        {
          name: `${chalk.bold("Strict (Default Deny)")} — ${chalk.dim(
            "Safest. Blocks all unknown traffic. Prompts you to approve new connections.",
          )}`,
          value: "strict",
        },
        {
          name: `${chalk.bold("Audit Only (Default Allow)")} — ${chalk.dim(
            "Least friction. Allows all traffic but logs everything for your review.",
          )}`,
          value: "audit",
        },
      ],
      default: "strict",
    },
  ]);

  log.blank();

  // Create workspace directory if it does not exist
  const setupSpinner = ora("Setting up workspace and config…").start();
  if (!existsSync(workspacePath)) {
    await mkdir(workspacePath, { recursive: true });
  }

  // ── Write the initial policy file ──────────────────────────────────────
  const policyPath = defaultPolicyPath();
  const defaultVerdict = securityMode === "audit" ? "allow" : "deny";

  const basePolicy: Policy = {
    version: "1",
    name: securityMode === "audit" ? "audit-only" : "strict",
    description:
      securityMode === "audit"
        ? "Audit-only policy — all traffic is allowed and logged for review."
        : "Strict deny-all policy — blocks unknown traffic, prompts for approval.",
    default: defaultVerdict,
    rules: [
      { host: "llm.gateway", action: "allow", comment: "SILO inference proxy" },
      { host: "localhost", action: "allow", comment: "Loopback" },
      { host: "127.0.0.1", action: "allow", comment: "Loopback IPv4" },
      { host: "::1", action: "allow", comment: "Loopback IPv6" },
    ],
  };

  writePolicyFile(policyPath, basePolicy);

  // For strict mode, auto-apply the "standard" preset (pypi + npm + github)
  // so the most common developer workflows work out of the box.
  const config: SiloConfig = {
    version: "1",
    llm: {
      provider,
      apiKey: apiKey.trim(),
      model: model.trim(),
      ...(baseUrl ? { baseUrl } : {}),
    },
    sandbox: {
      image: "silo-sandbox:latest",
      containerName: "silo-agent",
      workspacePath,
      cpuLimit,
      memoryLimit: memoryLimit.toLowerCase(),
      policyFile: policyPath,
    },
    proxy: {
      port: 8199,
      running: false,
      autoOpenLogs: true,
    },
    integrations: [],
    onboardedAt: new Date().toISOString(),
  };

  if (securityMode === "strict") {
    const standard = getPreset("standard");
    if (standard) {
      applyPreset(standard, config);
    }
  }

  writeConfig(config);
  setupSpinner.succeed("Configuration saved");

  // ── Completion Summary ──────────────────────────────────────────────────
  log.blank();
  log.success("Onboarding complete! Configuration saved.");
  log.blank();

  const brandGrad = gradient(["#6366f1", "#06b6d4"]);
  const policyLabel = securityMode === "audit"
    ? chalk.yellow.bold("AUDIT ONLY")
    : chalk.green.bold("STRICT");
  const policyIcon = securityMode === "audit" ? "👁 " : "🛡";
  const policyHint = securityMode === "audit"
    ? "All traffic allowed & logged"
    : "Deny-all + standard preset";

  console.log(`  ${chalk.bold("Setup Summary:")}`);
  console.log(`    ${chalk.dim("Provider:")}    ${chalk.white(provider)}`);
  console.log(`    ${chalk.dim("Model:")}       ${chalk.white(model.trim())}`);
  console.log(`    ${chalk.dim("Policy:")}      ${policyIcon} ${policyLabel} ${chalk.dim(`(${policyHint})`)}`);
  console.log(`    ${chalk.dim("Workspace:")}   ${chalk.white(workspacePath)}`);
  console.log(`    ${chalk.dim("Resources:")}   ${chalk.white(cpuLimit + " CPU")} ${chalk.dim("/")} ${chalk.white(memoryLimit)}`);
  log.blank();

  console.log(brandGrad("  ━━━ Next Steps ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
  log.blank();
  console.log(
    [
      `    ${chalk.cyan.bold("silo start")}      ${chalk.dim("→")}  Launch the agent sandbox`,
      `    ${chalk.cyan.bold("silo connect")}    ${chalk.dim("→")}  Open a shell inside the sandbox`,
      `    ${chalk.cyan.bold("silo status")}     ${chalk.dim("→")}  View sandbox health & active policy`,
      `    ${chalk.cyan.bold("silo logs")}       ${chalk.dim("→")}  Watch real-time network audit trail`,
    ].join("\n"),
  );
  log.blank();
  console.log(chalk.dim("  Happy sandboxing! 🚀"));
  log.blank();
}
