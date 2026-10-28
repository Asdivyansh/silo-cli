import Conf from "conf";
import { SiloConfigSchema, type SiloConfig, type PartialSiloConfig } from "./schema.js";
import { ensureEncrypted, ensureDecrypted } from "./encryption.js";

/**
 * Persistent config store backed by `conf`.
 * On macOS this lives at ~/Library/Preferences/cli-silo-nodejs/config.json.
 * On Linux: ~/.config/cli-silo-nodejs/config.json.
 *
 * Secrets (API keys and integration tokens) are encrypted at rest using
 * AES-256-GCM with a machine-bound key. See `encryption.ts` for details.
 */
const store = new Conf<Record<string, unknown>>({
  projectName: "cli-silo",
  projectVersion: "1",
});

/**
 * Read and validate the full config.
 * Secrets are transparently decrypted so callers always see plaintext.
 * Returns null if no config has been written yet (pre-onboard state).
 */
export function readConfig(): SiloConfig | null {
  const raw = store.store;
  if (!raw || Object.keys(raw).length === 0) return null;

  const result = SiloConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `Corrupted config at ${store.path}. Run \`silo onboard\` to reconfigure.\n` +
        result.error.message,
    );
  }

  return decryptSecrets(result.data);
}

/**
 * Write a validated config to disk.
 * Performs full Zod validation before persisting.
 * Secrets are encrypted before writing.
 */
export function writeConfig(config: SiloConfig): void {
  const encrypted = encryptSecrets(config);
  const result = SiloConfigSchema.safeParse(encrypted);
  if (!result.success) {
    throw new Error(`Invalid config: ${result.error.message}`);
  }
  store.store = result.data as unknown as Record<string, unknown>;
}

/**
 * Merge partial updates into the existing config.
 * Throws if there is no existing config (call writeConfig after onboard instead).
 */
export function patchConfig(patch: PartialSiloConfig): SiloConfig {
  const existing = readConfig();
  if (!existing) {
    throw new Error("No config found. Run `silo onboard` first.");
  }
  const merged = deepMerge(existing, patch as Partial<SiloConfig>) as SiloConfig;
  writeConfig(merged);
  return merged;
}

/** Return the filesystem path to the config file (useful for `status` display). */
export function configPath(): string {
  return store.path;
}

/** Wipe the entire config (used by uninstall / reset flows). */
export function clearConfig(): void {
  store.clear();
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function deepMerge<T extends object>(target: T, source: Partial<T>): T {
  const output = { ...target };
  for (const key of Object.keys(source) as Array<keyof T>) {
    const val = source[key];
    if (val !== undefined && val !== null) {
      if (
        typeof val === "object" &&
        !Array.isArray(val) &&
        typeof target[key] === "object" &&
        target[key] !== null
      ) {
        (output as Record<string, unknown>)[key as string] = deepMerge(
          target[key] as object,
          val as object,
        );
      } else {
        (output as Record<string, unknown>)[key as string] = val;
      }
    }
  }
  return output;
}

/**
 * Encrypt all secret fields before writing to disk.
 * Uses `ensureEncrypted` so already-encrypted values are not double-encrypted.
 */
function encryptSecrets(config: SiloConfig): SiloConfig {
  return {
    ...config,
    llm: {
      ...config.llm,
      apiKey: ensureEncrypted(config.llm.apiKey),
    },
    integrations: (config.integrations ?? []).map((int) => ({
      ...int,
      token: ensureEncrypted(int.token),
    })),
  };
}

/**
 * Decrypt all secret fields after reading from disk.
 * Uses `ensureDecrypted` so plaintext values (pre-encryption migration) pass through.
 */
function decryptSecrets(config: SiloConfig): SiloConfig {
  return {
    ...config,
    llm: {
      ...config.llm,
      apiKey: ensureDecrypted(config.llm.apiKey),
    },
    integrations: (config.integrations ?? []).map((int) => ({
      ...int,
      token: ensureDecrypted(int.token),
    })),
  };
}

