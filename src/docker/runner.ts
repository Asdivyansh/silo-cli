import { execa } from "execa";
import type { SandboxConfig, ProxyConfig, IntegrationConfig } from "../config/schema.js";
import { buildRunFlags, resolveGatewayMode } from "./templates.js";
import { log } from "../utils/logger.js";

/**
 * Start the agent sandbox container.
 * Returns the new container ID.
 */
export async function startContainer(
  sandbox: SandboxConfig,
  proxy: ProxyConfig,
  integrations?: IntegrationConfig[],
  frameworkMeta?: {
    id: string;
    envVars?: Record<string, string>;
    tmpfsMounts?: string[];
    tmpfsMountSizes?: Record<string, string>;
    browser?: boolean;
  },
): Promise<string> {
  const flags = buildRunFlags(sandbox, proxy, integrations, frameworkMeta, resolveGatewayMode());
  log.debug(`docker run ${flags.join(" ")}`);

  const { stdout } = await execa("docker", ["run", ...flags]);
  return stdout.trim();
}

/**
 * Stop and remove the sandbox container.
 */
export async function stopContainer(containerName: string): Promise<void> {
  log.debug(`Stopping container ${containerName}`);
  try {
    await execa("docker", ["stop", containerName]);
  } catch {
    // Container may already be stopped — that's fine.
  }
  await execa("docker", ["rm", "--force", containerName]);
}



/**
 * Build the sandbox image from the embedded Dockerfile.
 */
export async function buildSandboxImage(
  dockerfilePath: string,
  contextDir: string,
  tag: string,
): Promise<void> {
  await execa(
    "docker",
    ["build", "--file", dockerfilePath, "--tag", tag, contextDir],
    { stdio: "inherit" },
  );
}

/**
 * Return raw JSON from `docker inspect` for a given container.
 */
export async function inspectContainer(
  containerName: string,
): Promise<Record<string, unknown>> {
  const { stdout } = await execa("docker", [
    "inspect",
    "--format",
    "{{json .}}",
    containerName,
  ]);
  return JSON.parse(stdout) as Record<string, unknown>;
}

/**
 * Fetch live resource usage stats as a single snapshot.
 */
export async function containerStats(containerName: string): Promise<{
  cpu: string;
  memory: string;
}> {
  try {
    const { stdout } = await execa("docker", [
      "stats",
      "--no-stream",
      "--format",
      "{{.CPUPerc}}\t{{.MemUsage}}",
      containerName,
    ]);
    const [cpu = "—", memory = "—"] = stdout.trim().split("\t");
    return { cpu, memory };
  } catch {
    return { cpu: "—", memory: "—" };
  }
}
