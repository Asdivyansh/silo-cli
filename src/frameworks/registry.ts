/**
 * Framework Registry
 *
 * Core types and lookup functions for the multi-agent framework
 * orchestration system. Each supported framework is described by a
 * `FrameworkDefinition` that tells SILO how to install, configure,
 * health-check, and launch the framework inside a sandbox container.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FrameworkInstallConfig {
  /** Installation method: "pip" for Python, "npm" for Node, "custom" for raw Dockerfile */
  method: "pip" | "npm" | "custom";
  /** Packages to install (e.g. ["crewai", "crewai-tools"]) */
  packages: string[];
  /** Extra system packages via apt-get (e.g. ["build-essential"]) */
  systemDeps?: string[];
  /** Custom Dockerfile snippet (for method="custom") */
  dockerSnippet?: string;
}

export interface FrameworkDefinition {
  /** Unique identifier — used in CLI flags (e.g. "crewai") */
  id: string;
  /** Human-readable name */
  name: string;
  /** One-line description */
  description: string;
  /** Version to install ("latest" or a semver range) */
  version: string;
  /** Docker build / install instructions */
  install: FrameworkInstallConfig;
  /** Policy presets auto-applied when starting (e.g. ["pypi", "github"]) */
  requiredPolicies: string[];
  /** Extra policy rules specific to this framework */
  extraPolicyRules?: Array<{ host: string; action: "allow"; comment: string }>;
  /** Command to launch the framework's TUI (null = no TUI available) */
  tuiCommand: string | null;
  /** Shell command to verify the framework is installed and healthy */
  healthCheck: string;
  /** Custom entrypoint override (null = default tail -f /dev/null) */
  entrypoint: string | null;
  /** Command to run in the background before launching the TUI (e.g. gateway daemon) */
  prelaunchCommand?: string;
  /** Environment variables to inject into the sandbox container */
  envVars?: Record<string, string>;
  /** Runtime requirements checked before launching interactive framework tools */
  runtimeRequirements?: {
    /** Minimum Node.js version, e.g. ">=22.19.0" */
    node?: string;
  };
  /** Ports to expose/forward from the sandbox (for web UIs) */
  ports?: number[];
  /** Extra writable tmpfs mounts needed by the framework (e.g. ["/home/agent"]) */
  tmpfsMounts?: string[];
  /** Optional tmpfs size overrides by mount path (default: "32m") */
  tmpfsMountSizes?: Record<string, string>;
  /** Tags for filtering (e.g. ["python", "multi-agent"]) */
  tags: string[];
  /** Documentation URL */
  docsUrl: string;
  /** Display icon (emoji) */
  icon: string;
}

// ---------------------------------------------------------------------------
// Registry — populated by definitions.ts
// ---------------------------------------------------------------------------

const _registry = new Map<string, FrameworkDefinition>();

/** Register a framework definition. Called at module load by definitions.ts. */
export function registerFramework(def: FrameworkDefinition): void {
  _registry.set(def.id.toLowerCase(), def);
}

/** Look up a framework by its id. Returns undefined if not found. */
export function getFramework(id: string): FrameworkDefinition | undefined {
  return _registry.get(id.toLowerCase());
}

/** List all registered frameworks. */
export function listFrameworks(): FrameworkDefinition[] {
  return Array.from(_registry.values());
}

/** List framework IDs. */
export function listFrameworkIds(): string[] {
  return Array.from(_registry.keys());
}

/** Check whether a framework ID is valid. */
export function isValidFramework(id: string): boolean {
  return _registry.has(id.toLowerCase());
}

/** Get the Docker image tag for a framework. */
export function frameworkImageTag(
  frameworkId: string,
  opts: { browser?: boolean } = {},
): string {
  const suffix = opts.browser ? "-browser" : "";
  return `silo-sandbox-${frameworkId.toLowerCase()}${suffix}:latest`;
}
