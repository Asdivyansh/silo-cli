/**
 * Built-in Policy Presets
 *
 * Presets are named allow-rule collections layered on top of the active policy.
 * Applying a preset does NOT replace the policy file — it merges the preset's
 * rules into the existing file (or creates a new one from the deny-all base).
 *
 * Usage:
 *   silo policy apply pypi     → pip installs work
 *   silo policy apply npm      → npm installs work
 *   silo policy apply github   → git clone / GitHub API work
 */
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { stringify as stringifyYaml } from "yaml";
import type { SiloConfig } from "../config/schema.js";
import { parsePolicyFile } from "./engine.js";
import type { Policy, PolicyRule } from "./engine.js";

// ---------------------------------------------------------------------------
// Preset registry
// ---------------------------------------------------------------------------

export interface Preset {
  name: string;
  description: string;
  rules: PolicyRule[];
}

export const BUILTIN_PRESETS: Record<string, Preset> = {
  pypi: {
    name: "pypi",
    description: "Allow outbound access to PyPI for pip / pipx installs",
    rules: [
      { host: "pypi.org", action: "allow", comment: "PyPI package index" },
      { host: "files.pythonhosted.org", action: "allow", comment: "PyPI wheel/sdist downloads" },
      { host: "*.pythonhosted.org", action: "allow", comment: "PyPI CDN shards" },
    ],
  },
  npm: {
    name: "npm",
    description: "Allow outbound access to the npm / pnpm registry",
    rules: [
      { host: "registry.npmjs.org", action: "allow", comment: "npm package registry" },
      { host: "*.npmjs.org", action: "allow", comment: "npm CDN" },
    ],
  },
  github: {
    name: "github",
    description: "Allow outbound access to GitHub (git clone, REST API, raw files)",
    rules: [
      { host: "github.com", action: "allow", comment: "GitHub" },
      { host: "api.github.com", action: "allow", comment: "GitHub REST API" },
      { host: "raw.githubusercontent.com", action: "allow", comment: "Raw file access" },
      { host: "objects.githubusercontent.com", action: "allow", comment: "Git object storage" },
    ],
  },
  huggingface: {
    name: "huggingface",
    description: "Allow downloading models and datasets from Hugging Face Hub",
    rules: [
      { host: "huggingface.co", action: "allow", comment: "Hugging Face Hub" },
      { host: "cdn-lfs.huggingface.co", action: "allow", comment: "LFS storage" },
      { host: "*.hf.co", action: "allow", comment: "HF CDN" },
    ],
  },
  standard: {
    name: "standard",
    description: "Standard developer preset — PyPI + npm + GitHub (applied by default on onboard)",
    rules: [
      // PyPI
      { host: "pypi.org", action: "allow", comment: "PyPI package index" },
      { host: "files.pythonhosted.org", action: "allow", comment: "PyPI wheel/sdist downloads" },
      { host: "*.pythonhosted.org", action: "allow", comment: "PyPI CDN shards" },
      // npm
      { host: "registry.npmjs.org", action: "allow", comment: "npm package registry" },
      { host: "*.npmjs.org", action: "allow", comment: "npm CDN" },
      // GitHub
      { host: "github.com", action: "allow", comment: "GitHub" },
      { host: "api.github.com", action: "allow", comment: "GitHub REST API" },
      { host: "raw.githubusercontent.com", action: "allow", comment: "Raw file access" },
      { host: "objects.githubusercontent.com", action: "allow", comment: "Git object storage" },
    ],
  },
};

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

export function getPreset(name: string): Preset | undefined {
  return BUILTIN_PRESETS[name.toLowerCase()];
}

export function listPresets(): Preset[] {
  return Object.values(BUILTIN_PRESETS);
}

/**
 * Merge a preset into the policy file configured in `config`.
 *
 * If no policy file is configured, a new file at `~/.silo/policy.yaml`
 * is created starting from the built-in deny-all baseline.
 *
 * Rules contributed by the preset are appended only if a rule for that exact
 * host pattern does not already exist — applying the same preset twice is
 * therefore idempotent.
 *
 * @returns The path of the policy file that was written.
 */
export function applyPreset(preset: Preset, config: SiloConfig): string {
  const targetPath = resolve(config.sandbox.policyFile ?? defaultPolicyPath());

  // Load or bootstrap the policy
  let policy: Policy;
  if (existsSync(targetPath)) {
    policy = parsePolicyFile(targetPath);
  } else {
    policy = bootstrapPolicy(targetPath);
  }

  const existingHosts = new Set(policy.rules.map((r) => r.host));
  const newRules: PolicyRule[] = [];

  for (const rule of preset.rules) {
    if (!existingHosts.has(rule.host)) {
      newRules.push(rule);
    }
  }

  if (newRules.length === 0) {
    return targetPath; // Already applied — idempotent
  }

  const updated: Policy = {
    ...policy,
    rules: [...policy.rules, ...newRules],
  };

  writePolicyFile(targetPath, updated);
  return targetPath;
}

/**
 * Remove all rules contributed by a preset from the policy file.
 * Rules that were modified by the user since the preset was applied are
 * matched by host pattern only — the action/comment may differ.
 *
 * @returns The path of the policy file that was written.
 */
export function removePreset(preset: Preset, config: SiloConfig): string {
  const targetPath = resolve(config.sandbox.policyFile ?? defaultPolicyPath());

  if (!existsSync(targetPath)) return targetPath;

  const policy = parsePolicyFile(targetPath);
  const presetHosts = new Set(preset.rules.map((r) => r.host));

  const updated: Policy = {
    ...policy,
    rules: policy.rules.filter((r) => !presetHosts.has(r.host)),
  };

  writePolicyFile(targetPath, updated);
  return targetPath;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

export function defaultPolicyPath(): string {
  return `${homedir()}/.silo/policy.yaml`;
}

function bootstrapPolicy(targetPath: string): Policy {
  const dir = dirname(targetPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const base: Policy = {
    version: "1",
    name: "custom",
    description: "Generated by `silo policy apply`",
    default: "deny",
    rules: [
      { host: "llm.gateway", action: "allow", comment: "SILO inference proxy" },
    ],
  };

  writePolicyFile(targetPath, base);
  return base;
}

export function writePolicyFile(absPath: string, policy: Policy): void {
  const dir = dirname(absPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const yaml = stringifyYaml(policy, { indent: 2 });
  const header =
    "# Policy file managed by SILO — edit with care\n" +
    `# Last updated: ${new Date().toISOString()}\n\n`;
  writeFileSync(absPath, header + yaml, "utf8");
}
