/**
 * Custom Framework Definitions
 *
 * Lets users bring their own agent without forking SILO: drop a YAML (or
 * JSON) file into ~/.silo/frameworks/ and it registers like a built-in —
 * `silo build --framework <id>`, `silo start --framework <id>`,
 * `silo connect --tui`, policies, and audit all work identically.
 *
 * Minimal example (~/.silo/frameworks/my-agent.yaml):
 *
 *   id: my-agent
 *   name: My Agent
 *   description: My experimental autonomous agent
 *   install:
 *     method: pip
 *     packages: ["my-agent-pkg"]
 *   healthCheck: my-agent --version
 *   tuiCommand: my-agent          # optional
 *   envVars:                      # optional — route LLM calls via the proxy
 *     OPENAI_API_BASE: "http://llm.gateway:8199/v1"
 *     OPENAI_API_KEY: "silo-proxy-injected"
 *
 * A custom definition with the same id as a built-in overrides it (useful
 * for tweaking e.g. the OpenClaw config), with a warning.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, extname, basename } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { registerFramework, getFramework } from "./registry.js";
import type { FrameworkDefinition } from "./registry.js";
import { log } from "../utils/logger.js";

/** Directory scanned for user-provided framework definitions. */
export function customFrameworksDir(): string {
  return join(homedir(), ".silo", "frameworks");
}

// ---------------------------------------------------------------------------
// Validation schema — mirrors FrameworkDefinition with practical defaults
// ---------------------------------------------------------------------------

const installSchema = z.object({
  method: z.enum(["pip", "npm", "custom"]),
  packages: z.array(z.string()).default([]),
  systemDeps: z.array(z.string()).optional(),
  dockerSnippet: z.string().optional(),
});

const customFrameworkSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "id must be lowercase alphanumeric/hyphens"),
  name: z.string().min(1),
  description: z.string().default(""),
  version: z.string().default("latest"),
  install: installSchema,
  requiredPolicies: z.array(z.string()).default([]),
  extraPolicyRules: z
    .array(
      z.object({
        host: z.string(),
        action: z.literal("allow"),
        comment: z.string(),
      }),
    )
    .optional(),
  tuiCommand: z.string().nullable().default(null),
  healthCheck: z.string().min(1),
  entrypoint: z.string().nullable().default(null),
  prelaunchCommand: z.string().optional(),
  envVars: z.record(z.string()).optional(),
  runtimeRequirements: z.object({ node: z.string().optional() }).optional(),
  ports: z.array(z.number().int().positive()).optional(),
  tmpfsMounts: z.array(z.string()).optional(),
  tmpfsMountSizes: z.record(z.string()).optional(),
  tags: z.array(z.string()).default(["custom"]),
  docsUrl: z.string().default(""),
  icon: z.string().default("🤖"),
});

export interface CustomFrameworkLoadResult {
  /** IDs of successfully registered custom frameworks */
  loaded: string[];
  /** Per-file failures (bad YAML, schema violations) — non-fatal */
  errors: Array<{ file: string; message: string }>;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load and register every *.yaml / *.yml / *.json definition in `dir`.
 * Invalid files are skipped with a warning — a broken custom definition
 * must never take down the CLI.
 */
export function loadCustomFrameworks(
  dir: string = customFrameworksDir(),
): CustomFrameworkLoadResult {
  const result: CustomFrameworkLoadResult = { loaded: [], errors: [] };

  if (!existsSync(dir)) return result;

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) =>
      [".yaml", ".yml", ".json"].includes(extname(f).toLowerCase()),
    );
  } catch {
    return result;
  }

  for (const file of files.sort()) {
    const path = join(dir, file);
    try {
      const raw = readFileSync(path, "utf8");
      const data: unknown =
        extname(file).toLowerCase() === ".json" ? JSON.parse(raw) : parseYaml(raw);

      const parsed = customFrameworkSchema.safeParse(data);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const message = issue ? `${issue.path.join(".") || "(root)"}: ${issue.message}` : "invalid definition";
        result.errors.push({ file, message });
        log.warn(`Skipping custom framework "${file}": ${message}`);
        continue;
      }

      if (getFramework(parsed.data.id)) {
        log.warn(
          `Custom framework "${basename(file)}" overrides built-in definition "${parsed.data.id}".`,
        );
      }

      registerFramework(parsed.data as FrameworkDefinition);
      result.loaded.push(parsed.data.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push({ file, message });
      log.warn(`Skipping custom framework "${file}": ${message}`);
    }
  }

  return result;
}
