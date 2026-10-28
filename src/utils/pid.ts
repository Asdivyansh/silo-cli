/**
 * PID-file helpers for the detached proxy daemon.
 *
 * The PID file lives alongside the config store so it is isolated per-user
 * and survives reboots (stale PID files are detected and cleaned up).
 */
import { writeFile, readFile, unlink, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PID_DIR = join(homedir(), ".silo");
const PID_FILE = join(PID_DIR, "proxy.pid");

/** Write the current process PID to disk. */
export async function writePid(pid: number): Promise<void> {
  if (!existsSync(PID_DIR)) {
    await mkdir(PID_DIR, { recursive: true });
  }
  await writeFile(PID_FILE, String(pid), "utf8");
}

/**
 * Read the stored PID.
 * Returns null when the file does not exist or contains an invalid value.
 */
export async function readPid(): Promise<number | null> {
  try {
    const raw = await readFile(PID_FILE, "utf8");
    const pid = parseInt(raw.trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Delete the PID file. Non-fatal if it does not exist. */
export async function clearPid(): Promise<void> {
  try {
    await unlink(PID_FILE);
  } catch {
    // ignore ENOENT
  }
}

/** Absolute path of the PID file (for display in status). */
export function pidFilePath(): string {
  return PID_FILE;
}

/**
 * Returns true when the proxy process recorded in the PID file is alive.
 * Cleans up the stale PID file when the process is gone.
 */
export async function isProxyAlive(): Promise<boolean> {
  const pid = await readPid();
  if (pid === null) return false;

  try {
    // signal 0 = existence check; throws when the process does not exist
    process.kill(pid, 0);
    return true;
  } catch {
    // Stale PID — clean up so the next `silo start` doesn't get confused
    await clearPid();
    return false;
  }
}

/**
 * Gracefully stop the proxy daemon by sending SIGTERM.
 * Waits up to `timeoutMs` for the process to exit, then force-kills with SIGKILL.
 */
export async function stopProxyProcess(timeoutMs = 5_000): Promise<void> {
  const pid = await readPid();
  if (pid === null) return;

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Process is already gone
    await clearPid();
    return;
  }

  // Poll until the process exits or timeout
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(100);
    if (!(await isProxyAlive())) {
      await clearPid();
      return;
    }
  }

  // Force-kill if SIGTERM was not enough
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already dead
  }
  await clearPid();
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

