/**
 * Tests for proxy target resolution and the host-loopback guard.
 */
import { describe, it, expect } from "vitest";
import type { LookupAddress } from "node:dns";
import {
  resolveProxyTarget,
  normaliseHostname,
  isLoopbackAddress,
  isLoopbackHostname,
  guardedLookup,
  LOOPBACK_BLOCKED_CODE,
} from "../../src/proxy/target.js";

describe("resolveProxyTarget", () => {
  it("parses absolute-form http and https targets", () => {
    expect(resolveProxyTarget("http://example.com/a?b=1", "ignored")?.href).toBe(
      "http://example.com/a?b=1",
    );
    expect(resolveProxyTarget("https://example.com:8443/", undefined)?.port).toBe("8443");
  });

  it("uses the URL authority, not the Host header, for absolute-form requests", () => {
    expect(resolveProxyTarget("http://evil.example.com/x", "localhost")?.hostname).toBe(
      "evil.example.com",
    );
  });

  it("accepts an upper-case scheme and resolves it to the URL host", () => {
    expect(resolveProxyTarget("HTTP://evil.example.com/x", "localhost")?.hostname).toBe(
      "evil.example.com",
    );
  });

  it("rejects non-http schemes instead of falling back to the Host header", () => {
    expect(resolveProxyTarget("httpx://evil.example.com/x", "localhost")).toBeNull();
    expect(resolveProxyTarget("ftp://evil.example.com/x", "localhost")).toBeNull();
    expect(resolveProxyTarget("file:///etc/passwd", "localhost")).toBeNull();
  });

  it("builds origin-form targets from the Host header", () => {
    expect(resolveProxyTarget("/v1/chat", "llm.gateway:8199")?.hostname).toBe("llm.gateway");
  });

  it("rejects origin-form requests without a Host header", () => {
    expect(resolveProxyTarget("/v1/chat", undefined)).toBeNull();
    expect(resolveProxyTarget("/v1/chat", "")).toBeNull();
  });

  it("rejects unparseable targets", () => {
    expect(resolveProxyTarget("not a url", "example.com")).toBeNull();
    expect(resolveProxyTarget("*", "example.com")).toBeNull();
  });
});

describe("normaliseHostname", () => {
  it("lower-cases and strips brackets and trailing dots", () => {
    expect(normaliseHostname("[::1]")).toBe("::1");
    expect(normaliseHostname("Example.COM.")).toBe("example.com");
  });
});

describe("isLoopbackAddress", () => {
  it("matches IPv4 loopback and unspecified ranges", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.255.0.9")).toBe(true);
    expect(isLoopbackAddress("0.0.0.0")).toBe(true);
  });

  it("matches IPv6 loopback, unspecified and IPv4-mapped loopback", () => {
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::ffff:7f00:1")).toBe(true);
  });

  it("does not match public or non-loopback private addresses", () => {
    expect(isLoopbackAddress("93.184.216.34")).toBe(false);
    expect(isLoopbackAddress("10.0.0.1")).toBe(false);
    expect(isLoopbackAddress("2606:4700::1111")).toBe(false);
    expect(isLoopbackAddress("example.com")).toBe(false);
  });
});

describe("isLoopbackHostname", () => {
  it("matches localhost names in any case", () => {
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("LOCALHOST.")).toBe(true);
    expect(isLoopbackHostname("app.localhost")).toBe(true);
  });

  it("matches loopback IP literals, including bracketed IPv6", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
    expect(isLoopbackHostname("0.0.0.0")).toBe(true);
  });

  it("matches the hostnames URL produces for encoded loopback forms", () => {
    // WHATWG URL normalises decimal / short / mapped forms to these hostnames
    for (const raw of ["http://2130706433/", "http://127.1/", "http://0x7f.1/", "http://[::ffff:127.0.0.1]/"]) {
      expect(isLoopbackHostname(new URL(raw).hostname)).toBe(true);
    }
  });

  it("does not match ordinary hostnames", () => {
    expect(isLoopbackHostname("example.com")).toBe(false);
    expect(isLoopbackHostname("localhost.example.com")).toBe(false);
  });
});

describe("guardedLookup", () => {
  function lookup(host: string): Promise<{ err: NodeJS.ErrnoException | null; addresses: unknown }> {
    return new Promise((resolve) => {
      guardedLookup(host, { all: true }, (err, addresses) => resolve({ err, addresses }));
    });
  }

  it("refuses a name whose DNS answer is loopback", async () => {
    const { err } = await lookup("localhost");
    expect(err?.code).toBe(LOOPBACK_BLOCKED_CODE);
  });

  it("refuses numeric forms that the resolver turns into loopback", async () => {
    const { err } = await lookup("127.1");
    expect(err?.code).toBe(LOOPBACK_BLOCKED_CODE);
  });

  it("returns addresses for non-loopback names", async () => {
    const { err, addresses } = await lookup("10.1.2.3");
    expect(err).toBeNull();
    expect((addresses as LookupAddress[])[0]?.address).toBe("10.1.2.3");
  });

  it("returns a single address when all is not requested", async () => {
    const result = await new Promise<{ address: unknown; family: unknown }>((resolve) => {
      guardedLookup("10.1.2.3", {}, (_err, address, family) => resolve({ address, family }));
    });
    expect(result).toEqual({ address: "10.1.2.3", family: 4 });
  });
});
