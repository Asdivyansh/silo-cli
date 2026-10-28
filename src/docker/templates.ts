/**
 * Docker runtime configuration templates.
 *
 * All security-hardening flags for the sandbox container are defined here so
 * there is a single authoritative list to audit.
 *
 * Network isolation strategy
 * ──────────────────────────
 * Containers run on `silo-sandbox-net`, created with Docker's `--internal`
 * flag on every platform, so sandboxes cannot route directly to the public
 * internet. How the proxy hostname `llm.gateway` resolves depends on the
 * gateway mode:
 *
 *   "host-gateway" (native Linux) — internal bridges still allow
 *   host↔container traffic, so `--add-host llm.gateway:host-gateway` maps
 *   the alias straight to the host where the proxy listens.
 *
 *   "sidecar" (Docker Desktop on macOS/Windows) — containers live in a VM
 *   and an internal network has no route to the host, so `llm.gateway` is
 *   a DNS alias of the `silo-gateway` socat sidecar (see gateway.ts), which
 *   straddles the internal network and the default bridge and relays TCP
 *   to the host proxy via host.docker.internal.
 *
 * In both modes the only egress path is the policy proxy.
 */
import type { SandboxConfig, ProxyConfig, IntegrationConfig } from "../config/schema.js";

/** Name of the Docker bridge network created by `silo start`. */
export const SILO_NETWORK = "silo-sandbox-net";

/** How sandbox containers reach the host-side proxy. */
export type GatewayMode = "host-gateway" | "sidecar";

/** Pick the gateway mode for the current platform. */
export function resolveGatewayMode(): GatewayMode {
  return process.platform === "darwin" || process.platform === "win32"
    ? "sidecar"
    : "host-gateway";
}

interface FrameworkRuntimeMeta {
  id: string;
  envVars?: Record<string, string>;
  tmpfsMounts?: string[];
  tmpfsMountSizes?: Record<string, string>;
  browser?: boolean;
}

/**
 * Build the complete `docker run` argument array for the agent sandbox.
 *
 * Security hardening applied
 * ──────────────────────────
 * --user 1001:1001            Non-root UID/GID
 * --read-only                 Immutable root filesystem
 * --tmpfs /tmp                Writable ephemeral scratch space (noexec, nosuid)
 * --network silo-sandbox-net   SILO bridge network for proxy-routed egress
 * --cap-drop ALL              Drop all Linux capabilities
 * --security-opt no-new-privileges  Block setuid/setgid escalation
 * --pids-limit 128            Fork-bomb protection
 * --cpus / --memory           Resource throttles
 */
export function buildRunFlags(
  sandbox: SandboxConfig,
  proxy: ProxyConfig,
  integrations?: IntegrationConfig[],
  frameworkMeta?: FrameworkRuntimeMeta,
  gatewayMode: GatewayMode = "host-gateway",
): string[] {
  const proxyUrl = `http://llm.gateway:${proxy.port}`;

  const flags = [
    // ── Identity ─────────────────────────────────────────────────────────
    "--name", sandbox.containerName,
    "--detach",
    "--label", "managed-by=silo",

    // ── Resource limits ───────────────────────────────────────────────────
    "--cpus", sandbox.cpuLimit,
    "--memory", sandbox.memoryLimit,

    // ── Security hardening ────────────────────────────────────────────────
    "--user", "1001:1001",
    "--read-only",
    "--tmpfs", "/tmp:size=64m,noexec,nosuid",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "128",

    // ── Volumes ───────────────────────────────────────────────────────────
    "--volume", `${sandbox.workspacePath}:/workspace:rw`,

    // ── Networking ────────────────────────────────────────────────────────
    // SILO bridge: --internal on every platform (no direct internet route)
    "--network", SILO_NETWORK,
    // In host-gateway mode, resolve llm.gateway → host IP so the agent can
    // reach the proxy. In sidecar mode the alias is provided by the
    // silo-gateway container's network alias instead — an /etc/hosts entry
    // here would shadow that DNS alias with an unroutable address.
    ...(gatewayMode === "host-gateway"
      ? ["--add-host", "llm.gateway:host-gateway"]
      : []),

    // ── Proxy environment variables ───────────────────────────────────────
    // Standard vars that most HTTP clients (curl, requests, httpx) respect
    "--env", `http_proxy=${proxyUrl}`,
    "--env", `https_proxy=${proxyUrl}`,
    "--env", `HTTP_PROXY=${proxyUrl}`,
    "--env", `HTTPS_PROXY=${proxyUrl}`,
    // Localhost and llm.gateway must bypass the HTTP proxy to avoid circular routing.
    // Frameworks like OpenClaw make direct HTTP calls to the baseUrl (llm.gateway:8199),
    // which would otherwise get routed *through* the proxy to the proxy.
    "--env", "no_proxy=localhost,127.0.0.1,::1,llm.gateway",
    "--env", "NO_PROXY=localhost,127.0.0.1,::1,llm.gateway",

    // ── Sandbox marker ────────────────────────────────────────────────────
    "--env", "SILO_SANDBOX=1",
  ];

  // Browser automation profile: keep /tmp noexec and give Chromium isolated,
  // disposable runfiles plus a larger shared-memory segment.
  if (frameworkMeta?.browser) {
    flags.push("--shm-size", "512m");
    flags.push("--tmpfs", "/browser-cache:size=512m,uid=1001,gid=1001,nosuid");
    flags.push("--tmpfs", "/browser-profile:size=256m,uid=1001,gid=1001,nosuid");
    flags.push("--tmpfs", "/browser-downloads:size=256m,uid=1001,gid=1001,nosuid");
    flags.push("--env", "SILO_BROWSER=1");
    flags.push("--env", "CHROME_BIN=/usr/local/bin/silo-chromium");
    flags.push("--env", "CHROMIUM_BIN=/usr/local/bin/silo-chromium");
    flags.push("--env", "BROWSER_EXECUTABLE_PATH=/usr/local/bin/silo-chromium");
    flags.push("--env", "PUPPETEER_EXECUTABLE_PATH=/usr/local/bin/silo-chromium");
    flags.push("--env", "PUPPETEER_SKIP_DOWNLOAD=true");
    flags.push("--env", "PUPPETEER_CACHE_DIR=/browser-cache/puppeteer");
    flags.push("--env", "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1");
    flags.push("--env", "XDG_CACHE_HOME=/browser-cache");
    flags.push("--env", "XDG_CONFIG_HOME=/browser-profile");
    flags.push("--env", "SILO_BROWSER_PROFILE_DIR=/browser-profile");
    flags.push("--env", "SILO_BROWSER_DOWNLOADS_DIR=/browser-downloads");
    flags.push(
      "--env",
      "SILO_BROWSER_ARGS=--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage --user-data-dir=/browser-profile",
    );
  }

  const hostMounts = sandbox.hostMounts ?? [];
  for (const mount of hostMounts) {
    flags.push("--volume", `${mount.source}:${mount.target}:${mount.mode}`);
  }

  if (hostMounts.length > 0) {
    flags.push("--env", `SILO_HOST_MOUNTS=${hostMounts.map((m) => m.target).join(",")}`);
  }

  if (hostMounts.some((m) => m.target === "/host/Desktop")) {
    flags.push("--env", "SILO_HOST_DESKTOP=/host/Desktop");
  }

  // ── Framework metadata ──────────────────────────────────────────────────
  if (frameworkMeta) {
    flags.push("--label", `silo.framework=${frameworkMeta.id}`);
    flags.push("--env", `SILO_FRAMEWORK=${frameworkMeta.id}`);

    // Inject framework-specific env vars
    if (frameworkMeta.envVars) {
      for (const [key, val] of Object.entries(frameworkMeta.envVars)) {
        flags.push("--env", `${key}=${val}`);
      }
    }

    // Inject framework-specific writable tmpfs mounts
    if (frameworkMeta.tmpfsMounts) {
      for (const mount of frameworkMeta.tmpfsMounts) {
        const size = frameworkMeta.tmpfsMountSizes?.[mount] ?? "32m";
        flags.push("--tmpfs", `${mount}:size=${size},uid=1001,gid=1001,nosuid`);
      }
    }
  }

  // ── Integration gateway aliases ───────────────────────────────────────
  // Each integration gets a DNS alias so the container can resolve
  // e.g. slack.gateway → the proxy. In sidecar mode these aliases are
  // carried by the silo-gateway container, not /etc/hosts entries.
  if (gatewayMode === "host-gateway" && integrations && integrations.length > 0) {
    for (const integration of integrations) {
      flags.push("--add-host", `${integration.gateway}:host-gateway`);
    }
  }

  // ── Image (must be last) ────────────────────────────────────────────────
  flags.push(sandbox.image);

  return flags;
}
