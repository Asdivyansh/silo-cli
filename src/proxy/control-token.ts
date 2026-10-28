/**
 * Control token for the proxy's operator-only endpoints.
 *
 * The prompt endpoints (`/_silo/prompts`) let the operator approve blocked
 * requests. The sandbox can reach the proxy, so these endpoints must not
 * trust the network: on Docker Desktop, container traffic can even arrive
 * from host loopback. Instead the daemon writes a random token to a 0600 file
 * under ~/.silo, which only host processes running as the user can read, and
 * the CLI listener sends it with every control request.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const CONTROL_TOKEN_HEADER = "x-silo-control-token";

const DEFAULT_TOKEN_FILE = join(homedir(), ".silo", "proxy-control.token");

/** Generate a fresh token and write it to disk with owner-only permissions. */
export async function createControlToken(path = DEFAULT_TOKEN_FILE): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Remove any previous file so the new one is created with mode 0600.
  await unlink(path).catch(() => {});
  await writeFile(path, token, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await chmod(path, 0o600);
  return token;
}

/** Read the current token, or null when the daemon has not written one. */
export async function readControlToken(path = DEFAULT_TOKEN_FILE): Promise<string | null> {
  try {
    const token = (await readFile(path, "utf8")).trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/** Delete the token file. Non-fatal if it does not exist. */
export async function clearControlToken(path = DEFAULT_TOKEN_FILE): Promise<void> {
  await unlink(path).catch(() => {});
}

/** Constant-time comparison of a provided token against the expected one. */
export function controlTokenMatches(
  expected: string | undefined,
  provided: string | string[] | undefined,
): boolean {
  if (!expected || typeof provided !== "string") return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
