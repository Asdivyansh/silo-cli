/**
 * YAML Policy Engine
 *
 * Reads and validates a policy YAML file, compiles the host patterns into
 * picomatch matchers for efficient evaluation, and exposes a hot-reload
 * mechanism that the proxy daemon triggers on SIGHUP.
 *
 * Policy file format
 * ──────────────────
 *   version: "1"
 *   name:    "my-policy"
 *   default: deny          # deny | allow
 *   rules:
 *     - host: "llm.gateway"
 *       action: allow
 *     - host: "*.pypi.org"
 *       action: allow
 *     - host: "*.npmjs.com"
 *       action: deny
 *
 * Rules are evaluated top-to-bottom; the first match wins.
 * `default` applies when no rule matches.
 *
 * Glob patterns follow picomatch semantics (same as micromatch):
 *   *        matches any character except "."
 *   **       matches any character including "."
 *   {a,b}    brace expansion
 *   [a-z]    character class
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import picomatch from "picomatch";
import { z } from "zod";
import type { SiloConfig } from "../config/schema.js";


// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const PolicyRuleSchema = z.object({
  host: z.string().min(1, "host pattern cannot be empty"),
  action: z.enum(["allow", "deny"]),
  comment: z.string().optional(),
});

const PolicySchema = z.object({
  version: z.string(),
  name: z.string(),
  description: z.string().optional(),
  default: z.enum(["allow", "deny"]),
  rules: z.array(PolicyRuleSchema),
});

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

export type Policy = z.infer<typeof PolicySchema>;

/** A compiled policy with pre-built picomatch matchers for O(n) evaluation. */
export interface CompiledPolicy {
  source: Policy;
  compiledRules: CompiledRule[];
}

interface CompiledRule {
  raw: PolicyRule;
  /** Returns true when the given host matches this rule's pattern. */
  test: (host: string) => boolean;
}

// ---------------------------------------------------------------------------
// Built-in fallback (deny-all)
// ---------------------------------------------------------------------------

const BUILTIN_DENY_ALL: Policy = {
  version: "1",
  name: "built-in deny-all",
  default: "deny",
  rules: [
    { host: "llm.gateway", action: "allow", comment: "LLM inference proxy" },
  ],
};

// ---------------------------------------------------------------------------
// Policy loading
// ---------------------------------------------------------------------------

/**
 * Load and validate a policy from disk.
 * Falls back to the built-in deny-all policy when no file is configured.
 *
 * @throws When the file exists but contains invalid YAML or fails Zod validation.
 */
export async function loadPolicy(config: SiloConfig): Promise<Policy> {
  const filePath = config.sandbox.policyFile;
  if (!filePath) return BUILTIN_DENY_ALL;

  const absPath = resolve(filePath);
  return parsePolicyFile(absPath);
}

/**
 * Parse and validate a policy YAML file from an absolute path.
 *
 * @throws {Error} When the file cannot be read or the content is invalid.
 */
export function parsePolicyFile(absPath: string): Policy {
  let raw: string;
  try {
    raw = readFileSync(absPath, "utf8");
  } catch (err) {
    throw new Error(`Cannot read policy file "${absPath}": ${String(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new Error(`YAML parse error in "${absPath}": ${String(err)}`);
  }

  const result = PolicySchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid policy schema in "${absPath}":\n${issues}`);
  }

  return result.data;
}

// ---------------------------------------------------------------------------
// Policy compilation & evaluation
// ---------------------------------------------------------------------------

/** Compile a policy object into a form that can be evaluated cheaply. */
export function compilePolicy(policy: Policy): CompiledPolicy {
  return {
    source: policy,
    compiledRules: policy.rules.map((rule) => ({
      raw: rule,
      test: picomatch(rule.host, { nocase: true }),
    })),
  };
}

/**
 * Evaluate a compiled policy against a host string.
 * Returns "allow" or "deny"; never throws.
 */
export function evaluateCompiled(compiled: CompiledPolicy, host: string): "allow" | "deny" {
  for (const rule of compiled.compiledRules) {
    if (rule.test(host)) {
      return rule.raw.action;
    }
  }
  return compiled.source.default;
}

/**
 * Convenience wrapper: compile then evaluate.
 * Prefer `evaluateCompiled` in hot paths (the proxy runs this per-request).
 */
export function evaluate(policy: Policy, host: string): "allow" | "deny" {
  return evaluateCompiled(compilePolicy(policy), host);
}

// ---------------------------------------------------------------------------
// Hot-reload watcher
// ---------------------------------------------------------------------------


