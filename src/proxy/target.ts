/**
 * Proxy target resolution and host-loopback protection.
 *
 * The proxy runs on the host, so whatever it connects to is reached from the
 * host's network namespace. Two rules keep that safe:
 *
 *  1. The policy check and the upstream connection must use the *same* parsed
 *     target. `resolveProxyTarget` is the single parser for both.
 *  2. Host-loopback destinations (localhost, 127.0.0.0/8, ::1, 0.0.0.0, ::)
 *     are never reachable through the proxy, whatever the policy says —
 *     including hostnames that only resolve to loopback via DNS.
 */
import { BlockList, isIP, type LookupFunction } from "node:net";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { URL } from "node:url";

/** Error code used when a destination is refused by the loopback guard. */
export const LOOPBACK_BLOCKED_CODE = "ESILOLOOPBACK";

const LOOPBACK_BLOCKLIST = new BlockList();
LOOPBACK_BLOCKLIST.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK_BLOCKLIST.addSubnet("0.0.0.0", 8, "ipv4");
LOOPBACK_BLOCKLIST.addAddress("::1", "ipv6");
LOOPBACK_BLOCKLIST.addAddress("::", "ipv6");

/**
 * Parse the target of a plain-HTTP proxy request.
 *
 * - Absolute-form (`http://host/path`) must use the http or https scheme.
 * - Origin-form (`/path`) takes its authority from the Host header.
 *
 * Returns null when the target cannot be determined unambiguously; callers
 * must reject the request rather than fall back to another source.
 */
export function resolveProxyTarget(rawUrl: string, hostHeader: string | undefined): URL | null {
  let url: URL;
  try {
    if (rawUrl.startsWith("/")) {
      if (!hostHeader) return null;
      url = new URL(`http://${hostHeader}${rawUrl}`);
    } else {
      url = new URL(rawUrl);
    }
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;
  return url;
}

/** Hostname without IPv6 brackets or a trailing dot, lower-cased. */
export function normaliseHostname(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

/** True for loopback or unspecified IP addresses (IPv4, IPv6, IPv4-mapped IPv6). */
export function isLoopbackAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return LOOPBACK_BLOCKLIST.check(ip, "ipv4");
  if (family === 6) return LOOPBACK_BLOCKLIST.check(ip, "ipv6");
  return false;
}

/**
 * True when a hostname is, on its face, the host's own loopback: `localhost`,
 * any `*.localhost` name, or a loopback/unspecified IP literal. Names that
 * only resolve to loopback via DNS are caught by `guardedLookup` instead.
 */
export function isLoopbackHostname(host: string): boolean {
  const h = normaliseHostname(host);
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  return isLoopbackAddress(h);
}

/**
 * DNS lookup for upstream connections that fails when any resolved address is
 * a host-loopback address. Pass it as the `lookup` option to `net`/`http`.
 */
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
    if (err) {
      callback(err, "", 0);
      return;
    }
    if (addresses.length === 0 || addresses.some((a) => isLoopbackAddress(a.address))) {
      const blocked = Object.assign(
        new Error(`SILO blocked ${hostname}: resolves to a host-loopback address`),
        { code: LOOPBACK_BLOCKED_CODE },
      );
      callback(blocked, "", 0);
      return;
    }
    if (options.all) {
      callback(null, addresses);
    } else {
      callback(null, addresses[0]!.address, addresses[0]!.family);
    }
  });
};
