import { execa } from "execa";
import { log } from "./logger.js";

/**
 * Verify Docker is installed and the daemon is reachable.
 * Exits the process with an informative message if not.
 */
export async function assertDockerAvailable(): Promise<void> {
  try {
    await execa("docker", ["info"], { stdio: "ignore" });
  } catch {
    log.error("Docker is not running or not installed.");
    log.info(
      "Install Docker Desktop from https://www.docker.com/products/docker-desktop/ and ensure the daemon is running.",
    );
    process.exit(1);
  }
}

/**
 * Returns true if a container with the given name is currently running.
 */
export async function isContainerRunning(name: string): Promise<boolean> {
  try {
    const { stdout } = await execa("docker", [
      "inspect",
      "--format",
      "{{.State.Running}}",
      name,
    ]);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Returns true if a container with the given name exists (running or stopped).
 */
export async function containerExists(name: string): Promise<boolean> {
  try {
    await execa("docker", ["inspect", name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the current Node.js version as a semver string.
 */
export function nodeVersion(): string {
  return process.version;
}

/**
 * Check that the running Node version meets the minimum requirement.
 */
export function assertNodeVersion(minMajor = 18): void {
  const major = parseInt(process.version.slice(1).split(".")[0]!, 10);
  if (major < minMajor) {
    log.error(`Node.js ${minMajor}+ is required (found ${process.version}).`);
    process.exit(1);
  }
}
