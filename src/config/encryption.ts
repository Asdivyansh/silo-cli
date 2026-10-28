/**
 * Credential Encryption
 *
 * Provides AES-256-GCM encryption for secrets stored at rest in the SILO
 * config file (API keys and integration tokens). The encryption key is
 * derived from a machine-bound seed using PBKDF2.
 *
 * Machine binding:
 *   The seed is derived from `os.hostname()` + `os.homedir()` + a
 *   fixed salt unique to SILO. This means the config is not portable
 *   between machines — which is intentional for a security product.
 *
 * Encrypted values are stored as `enc:v1:<iv>:<authTag>:<ciphertext>`
 * so they are distinguishable from plaintext values during migration.
 */
import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync } from "node:crypto";
import { hostname, homedir } from "node:os";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 16;
const KEY_BYTES = 32;
const PBKDF2_ITERATIONS = 100_000;

/** Fixed application salt — not secret, just unique to SILO. */
const APP_SALT = "silo-credential-store-v1";

/** Prefix that identifies encrypted values in the config file. */
export const ENCRYPTED_PREFIX = "enc:v1:";

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

let _derivedKey: Buffer | null = null;

/**
 * Derive a 256-bit encryption key from machine-bound properties.
 * The key is cached in memory for the lifetime of the process.
 */
function deriveKey(): Buffer {
  if (_derivedKey) return _derivedKey;

  const seed = `${hostname()}:${homedir()}:silo`;
  _derivedKey = pbkdf2Sync(seed, APP_SALT, PBKDF2_ITERATIONS, KEY_BYTES, "sha512");
  return _derivedKey;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Encrypt a plaintext secret string.
 * Returns an encoded string: `enc:v1:<iv>:<authTag>:<ciphertext>` (all hex).
 */
export function encryptSecret(plaintext: string): string {
  const key = deriveKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return `${ENCRYPTED_PREFIX}${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * Decrypt an encrypted secret string.
 * Accepts the encoded format produced by `encryptSecret()`.
 *
 * @throws {Error} If the value is not in the expected format or decryption fails.
 */
export function decryptSecret(encoded: string): string {
  if (!isEncrypted(encoded)) {
    throw new Error("Value is not an encrypted secret (missing enc:v1: prefix)");
  }

  const parts = encoded.slice(ENCRYPTED_PREFIX.length).split(":");
  if (parts.length !== 3) {
    throw new Error("Malformed encrypted value — expected iv:authTag:ciphertext");
  }

  const [ivHex, authTagHex, ciphertextHex] = parts;
  const key = deriveKey();
  const iv = Buffer.from(ivHex!, "hex");
  const authTag = Buffer.from(authTagHex!, "hex");
  const ciphertext = Buffer.from(ciphertextHex!, "hex");

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

/**
 * Return true if the value looks like an encrypted secret.
 */
export function isEncrypted(value: string): boolean {
  return value.startsWith(ENCRYPTED_PREFIX);
}

/**
 * Encrypt a value only if it is not already encrypted (idempotent).
 */
export function ensureEncrypted(value: string): string {
  return isEncrypted(value) ? value : encryptSecret(value);
}

/**
 * Decrypt a value only if it is encrypted; return plaintext as-is.
 * This allows transparent migration from plaintext to encrypted configs.
 */
export function ensureDecrypted(value: string): string {
  return isEncrypted(value) ? decryptSecret(value) : value;
}
