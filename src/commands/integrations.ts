/**
 * `silo integrations` — Manage Credential-Managed Integrations
 *
 * Integrations let sandboxed agents call external APIs (Slack, GitHub, HubSpot,
 * etc.) without ever seeing the real credentials. Each integration gets a
 * gateway alias (e.g. `slack.gateway`) that the proxy intercepts, injects
 * credentials, and forwards to the real API — just like `llm.gateway` for LLMs.
 *
 * Subcommands:
 *   add <service>     — Add a new integration (interactive wizard)
 *   list              — List all configured integrations
 *   remove <name>     — Remove an integration
 *   test <name>       — Test connectivity through the proxy
 */
import inquirer from "inquirer";
import chalk from "chalk";
import Table from "cli-table3";
import { readConfig, patchConfig } from "../config/manager.js";
import type { IntegrationConfig, IntegrationAuthType } from "../config/schema.js";
import { getTemplate, listTemplates } from "../integrations/templates.js";
import { log, section } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// silo integrations add <service>
// ---------------------------------------------------------------------------

export async function runIntegrationsAdd(service: string): Promise<void> {
  const config = readConfig();
  if (!config) {
    log.error("No configuration found. Run `silo onboard` first.");
    process.exit(1);
  }

  const existing = config.integrations ?? [];

  // Check for duplicate
  const normalised = service.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  if (existing.some((i) => i.name === normalised)) {
    log.warn(`Integration "${normalised}" is already configured.`);
    log.info(`Run ${chalk.cyan(`silo integrations remove ${normalised}`)} first to reconfigure.`);
    return;
  }

  const template = getTemplate(service);

  let name: string;
  let baseUrl: string;
  let authType: IntegrationAuthType;
  let authHeader: string | undefined;
  let authQueryParam: string | undefined;
  let extraHeaders: Record<string, string> | undefined;
  let description: string | undefined;

  if (template) {
    // Template-based: pre-fill everything, prompt only for token
    log.info(`Using built-in template: ${chalk.cyan(template.displayName)}`);
    log.info(chalk.dim(template.description));
    log.blank();

    name = template.name;
    baseUrl = template.baseUrl;
    authType = template.authType;
    authHeader = template.authHeader;
    authQueryParam = template.authQueryParam;
    extraHeaders = template.extraHeaders;
    description = template.description;

    log.info(chalk.dim(`Docs: ${template.docsUrl}`));
    log.blank();
  } else {
    // Custom integration: prompt for everything
    log.info(`Setting up custom integration: ${chalk.cyan(normalised)}`);
    log.blank();

    name = normalised;

    const answers = await inquirer.prompt<{
      baseUrl: string;
      authType: IntegrationAuthType;
      description: string;
    }>([
      {
        type: "input",
        name: "baseUrl",
        message: "API base URL (e.g. https://api.example.com):",
        validate: (v: string) => {
          try {
            new URL(v);
            return true;
          } catch {
            return "Enter a valid URL";
          }
        },
      },
      {
        type: "list",
        name: "authType",
        message: "Authentication type:",
        choices: [
          { name: "Bearer token (Authorization: Bearer <token>)", value: "bearer" },
          { name: "Custom header (e.g. x-api-key: <token>)", value: "header" },
          { name: "Query parameter (e.g. ?api_key=<token>)", value: "query" },
        ],
      },
      {
        type: "input",
        name: "description",
        message: "Description (optional):",
        default: "",
      },
    ]);

    baseUrl = answers.baseUrl;
    authType = answers.authType;
    description = answers.description || undefined;

    if (authType === "header") {
      const { headerName } = await inquirer.prompt<{ headerName: string }>([
        {
          type: "input",
          name: "headerName",
          message: "Header name (e.g. x-api-key):",
          default: "x-api-key",
        },
      ]);
      authHeader = headerName;
    }

    if (authType === "query") {
      const { paramName } = await inquirer.prompt<{ paramName: string }>([
        {
          type: "input",
          name: "paramName",
          message: "Query parameter name (e.g. api_key):",
          default: "api_key",
        },
      ]);
      authQueryParam = paramName;
    }
  }

  // Prompt for the token
  const tokenHint = template?.tokenHint ?? "API token or key";
  const { token } = await inquirer.prompt<{ token: string }>([
    {
      type: "password",
      name: "token",
      message: `${template?.displayName ?? name} API token (${tokenHint}):`,
      mask: "*",
      validate: (v: string) =>
        v.trim().length > 0 ? true : "Token cannot be empty.",
    },
  ]);

  const gateway = `${name}.gateway`;

  const integration: IntegrationConfig = {
    name,
    baseUrl,
    gateway,
    authType,
    token: token.trim(),
    ...(authHeader ? { authHeader } : {}),
    ...(authQueryParam ? { authQueryParam } : {}),
    ...(extraHeaders ? { extraHeaders } : {}),
    ...(description ? { description } : {}),
  };

  // Save to config
  const updatedIntegrations = [...existing, integration];
  patchConfig({ integrations: updatedIntegrations });

  log.blank();
  log.success(`Integration "${name}" configured!`);
  log.blank();
  log.info(`Gateway:  ${chalk.cyan(`http://${gateway}:${config.proxy.port}`)}`);
  log.info(`Base URL: ${chalk.dim(baseUrl)}`);
  log.info(`Auth:     ${chalk.dim(authType)}`);
  log.blank();

  console.log(
    [
      chalk.dim("  Usage inside the sandbox:"),
      `    ${chalk.cyan(`curl http://${gateway}:${config.proxy.port}/...`)}`,
      "",
      chalk.dim("  The proxy will inject your credentials automatically."),
      chalk.dim("  The agent never sees the real token."),
      "",
      chalk.yellow("  ⚠  Restart your sandbox for the new gateway to take effect:"),
      `    ${chalk.cyan("silo stop && silo start")}`,
    ].join("\n"),
  );
  log.blank();
}

// ---------------------------------------------------------------------------
// silo integrations list
// ---------------------------------------------------------------------------

export async function runIntegrationsList(): Promise<void> {
  const config = readConfig();
  if (!config) {
    log.error("No configuration found. Run `silo onboard` first.");
    process.exit(1);
  }

  const integrations = config.integrations ?? [];

  if (integrations.length === 0) {
    log.info("No integrations configured.");
    log.blank();
    log.info("Add one with:");
    log.blank();

    // Show available templates
    const templates = listTemplates();
    for (const t of templates) {
      console.log(`  ${chalk.cyan(`silo integrations add ${t.name}`)}  — ${t.description}`);
    }
    console.log(`  ${chalk.cyan("silo integrations add <name>")}     — custom integration`);
    log.blank();
    return;
  }

  section("Configured Integrations");
  log.blank();

  const table = new Table({
    head: [
      chalk.bold("Name"),
      chalk.bold("Gateway"),
      chalk.bold("Base URL"),
      chalk.bold("Auth"),
      chalk.bold("Token"),
    ],
    style: { head: [], border: [] },
  });

  for (const i of integrations) {
    table.push([
      chalk.cyan(i.name),
      i.gateway,
      chalk.dim(i.baseUrl),
      i.authType,
      chalk.dim("••••" + i.token.slice(-4)),
    ]);
  }

  console.log(table.toString());
  log.blank();
}

// ---------------------------------------------------------------------------
// silo integrations remove <name>
// ---------------------------------------------------------------------------

export async function runIntegrationsRemove(name: string): Promise<void> {
  const config = readConfig();
  if (!config) {
    log.error("No configuration found. Run `silo onboard` first.");
    process.exit(1);
  }

  const integrations = config.integrations ?? [];
  const normalised = name.toLowerCase();
  const idx = integrations.findIndex((i) => i.name === normalised);

  if (idx === -1) {
    log.warn(`No integration named "${normalised}" found.`);
    return;
  }

  const removed = integrations[idx]!;
  const updated = integrations.filter((_, i) => i !== idx);
  patchConfig({ integrations: updated });

  log.success(`Integration "${removed.name}" removed.`);
  log.info(
    chalk.dim(
      `Gateway ${removed.gateway} will no longer be available after restarting the sandbox.`,
    ),
  );
}

// ---------------------------------------------------------------------------
// silo integrations test <name>
// ---------------------------------------------------------------------------

export async function runIntegrationsTest(name: string): Promise<void> {
  const config = readConfig();
  if (!config) {
    log.error("No configuration found. Run `silo onboard` first.");
    process.exit(1);
  }

  const integrations = config.integrations ?? [];
  const normalised = name.toLowerCase();
  const integration = integrations.find((i) => i.name === normalised);

  if (!integration) {
    log.warn(`No integration named "${normalised}" found.`);
    return;
  }

  log.info(`Testing connectivity to ${chalk.cyan(integration.name)}…`);

  const { request: makeRequest } = await import("node:https");
  const { URL } = await import("node:url");

  const parsed = new URL(integration.baseUrl);
  const testPath = parsed.pathname === "/" ? "/" : parsed.pathname;

  try {
    const statusCode = await new Promise<number>((resolve, reject) => {
      const req = makeRequest(
        {
          hostname: parsed.hostname,
          port: parsed.port || 443,
          path: testPath,
          method: "GET",
          timeout: 5000,
          headers: {
            "user-agent": "SILO/0.2.0",
          },
        },
        (res) => {
          resolve(res.statusCode ?? 0);
          res.resume(); // consume body
        },
      );
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Connection timed out after 5s"));
      });
      req.end();
    });

    if (statusCode >= 200 && statusCode < 500) {
      log.success(`${integration.name}: reachable (HTTP ${statusCode})`);
    } else {
      log.warn(`${integration.name}: responded with HTTP ${statusCode}`);
    }
  } catch (err) {
    log.error(`${integration.name}: unreachable — ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// silo integrations templates (show available built-in templates)
// ---------------------------------------------------------------------------

export function runIntegrationsTemplates(): void {
  section("Available Integration Templates");
  log.blank();

  const templates = listTemplates();

  const table = new Table({
    head: [
      chalk.bold("Name"),
      chalk.bold("Service"),
      chalk.bold("Base URL"),
      chalk.bold("Auth"),
    ],
    style: { head: [], border: [] },
  });

  for (const t of templates) {
    table.push([
      chalk.cyan(t.name),
      t.displayName,
      chalk.dim(t.baseUrl),
      t.authType,
    ]);
  }

  console.log(table.toString());
  log.blank();
  log.info(`Add one with: ${chalk.cyan("silo integrations add <name>")}`);
  log.blank();
}
