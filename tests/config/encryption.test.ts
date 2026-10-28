/**
 * Tests for the credential encryption module.
 *
 * Validates AES-256-GCM encryption/decryption round-tripping, idempotency
 * helpers, and edge cases like empty strings and unicode content.
 */
import { describe, it, expect } from "vitest";
import {
  encryptSecret,
  decryptSecret,
  isEncrypted,
  ensureEncrypted,
  ensureDecrypted,
  ENCRYPTED_PREFIX,
} from "../../src/config/encryption.js";

describe("credential encryption", () => {
  // ── Round-trip ───────────────────────────────────────────────────────────

  it("encrypts and decrypts a simple string", () => {
    const plaintext = "sk-abc123def456";
    const encrypted = encryptSecret(plaintext);
    const decrypted = decryptSecret(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it("encrypts and decrypts an empty string", () => {
    const plaintext = "";
    const encrypted = encryptSecret(plaintext);
    const decrypted = decryptSecret(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it("encrypts and decrypts unicode content", () => {
    const plaintext = "密钥-🔑-clave";
    const encrypted = encryptSecret(plaintext);
    const decrypted = decryptSecret(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it("encrypts and decrypts long API keys", () => {
    const plaintext = "sk-ant-" + "a".repeat(500);
    const encrypted = encryptSecret(plaintext);
    const decrypted = decryptSecret(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  // ── Format ──────────────────────────────────────────────────────────────

  it("produces output with the enc:v1: prefix", () => {
    const encrypted = encryptSecret("test-key");
    expect(encrypted.startsWith(ENCRYPTED_PREFIX)).toBe(true);
  });

  it("produces different ciphertexts for the same plaintext (random IV)", () => {
    const a = encryptSecret("same-key");
    const b = encryptSecret("same-key");
    expect(a).not.toBe(b);
    // But both decrypt to the same thing
    expect(decryptSecret(a)).toBe("same-key");
    expect(decryptSecret(b)).toBe("same-key");
  });

  it("produces output with 3 hex parts after the prefix", () => {
    const encrypted = encryptSecret("test");
    const parts = encrypted.slice(ENCRYPTED_PREFIX.length).split(":");
    expect(parts).toHaveLength(3);
    // All parts should be hex strings
    for (const part of parts) {
      expect(/^[0-9a-f]+$/i.test(part)).toBe(true);
    }
  });

  // ── isEncrypted ─────────────────────────────────────────────────────────

  it("identifies encrypted values", () => {
    const encrypted = encryptSecret("key");
    expect(isEncrypted(encrypted)).toBe(true);
  });

  it("identifies plaintext values", () => {
    expect(isEncrypted("sk-abc123")).toBe(false);
    expect(isEncrypted("")).toBe(false);
    expect(isEncrypted("enc:v0:old-format")).toBe(false);
  });

  // ── ensureEncrypted (idempotent) ────────────────────────────────────────

  it("encrypts plaintext values", () => {
    const result = ensureEncrypted("sk-test");
    expect(isEncrypted(result)).toBe(true);
    expect(decryptSecret(result)).toBe("sk-test");
  });

  it("does not double-encrypt already-encrypted values", () => {
    const encrypted = encryptSecret("sk-test");
    const result = ensureEncrypted(encrypted);
    // Should be the exact same string — not re-encrypted
    expect(result).toBe(encrypted);
    expect(decryptSecret(result)).toBe("sk-test");
  });

  // ── ensureDecrypted (transparent migration) ────────────────────────────

  it("decrypts encrypted values", () => {
    const encrypted = encryptSecret("sk-test");
    expect(ensureDecrypted(encrypted)).toBe("sk-test");
  });

  it("passes plaintext values through unchanged", () => {
    expect(ensureDecrypted("sk-plaintext-key")).toBe("sk-plaintext-key");
    expect(ensureDecrypted("")).toBe("");
  });

  // ── Error cases ────────────────────────────────────────────────────────

  it("throws on malformed encrypted value (wrong part count)", () => {
    expect(() => decryptSecret("enc:v1:only-one-part")).toThrow("Malformed");
  });

  it("throws on non-encrypted value passed to decryptSecret", () => {
    expect(() => decryptSecret("plain-text")).toThrow("not an encrypted secret");
  });

  it("throws on tampered ciphertext (auth tag verification fails)", () => {
    const encrypted = encryptSecret("test");
    // Flip the last character of the ciphertext
    const tampered = encrypted.slice(0, -1) + (encrypted.endsWith("0") ? "1" : "0");
    expect(() => decryptSecret(tampered)).toThrow();
  });
});
