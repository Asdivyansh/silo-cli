/**
 * Tests for the proxy control token used by the prompt endpoints.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createControlToken,
  readControlToken,
  clearControlToken,
  controlTokenMatches,
} from "../../src/proxy/control-token.js";

let dir: string;
let tokenPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "silo-token-"));
  tokenPath = join(dir, "nested", "proxy-control.token");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("control token file", () => {
  it("writes a random token readable only by the owner", async () => {
    const token = await createControlToken(tokenPath);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(await readControlToken(tokenPath)).toBe(token);
    if (process.platform !== "win32") {
      expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    }
  });

  it("rotates the token on every create", async () => {
    const first = await createControlToken(tokenPath);
    const second = await createControlToken(tokenPath);
    expect(second).not.toBe(first);
    expect(await readControlToken(tokenPath)).toBe(second);
  });

  it("returns null when no token exists and clears cleanly", async () => {
    expect(await readControlToken(tokenPath)).toBeNull();
    await createControlToken(tokenPath);
    await clearControlToken(tokenPath);
    expect(existsSync(tokenPath)).toBe(false);
    await expect(clearControlToken(tokenPath)).resolves.toBeUndefined();
  });
});

describe("controlTokenMatches", () => {
  it("accepts only the exact expected token", () => {
    expect(controlTokenMatches("abc123", "abc123")).toBe(true);
    expect(controlTokenMatches("abc123", "abc124")).toBe(false);
    expect(controlTokenMatches("abc123", "abc1234")).toBe(false);
  });

  it("rejects missing, array-valued or unconfigured tokens", () => {
    expect(controlTokenMatches("abc123", undefined)).toBe(false);
    expect(controlTokenMatches("abc123", ["abc123"])).toBe(false);
    expect(controlTokenMatches(undefined, "abc123")).toBe(false);
    expect(controlTokenMatches("", "")).toBe(false);
  });
});
