/**
 * Egress gateway sidecar for Docker Desktop platforms.
 *
 * Why this exists
 * ───────────────
 * On native Linux, `silo-sandbox-net` is an `--internal` bridge: containers
 * cannot route to the internet, but the host is still reachable through the
 * bridge interface, so `--add-host llm.gateway:host-gateway` is enough for
 * sandboxes to reach the proxy.
 *
 * On Docker Desktop (macOS/Windows) containers run inside a VM, and an
 * `--internal` network has no route back to the host at all. SILO used to
 * fall back to a standard bridge there — which silently gave sandboxes
 * unrestricted direct egress. Instead, the network is now `--internal` on
 * every platform, and on Docker Desktop SILO runs a minimal socat relay
 * (the "gateway sidecar") attached to BOTH networks:
 *
 *   sandbox ──internal net──▶ silo-gateway ──default bridge──▶ host proxy
 *            (llm.gateway DNS alias)        (host.docker.internal)
 *
 * The sidecar forwards a single TCP port to the host-side proxy, so the
 * only route out of the sandbox is through the policy engine. It carries
 * a DNS alias for `llm.gateway` plus one per integration gateway; the
 * proxy distinguishes them by Host header, which plain TCP relaying
 * preserves.
 */
import { execa } from "execa";
import type { IntegrationConfig } from "../config/schema.js";
import { SILO_NETWORK, resolveGatewayMode } from "./templates.js";

/** Name of the sidecar container created by `silo start` on Docker Desktop. */
export const GATEWAY_CONTAINER = "silo-gateway";

/** Small, single-purpose relay image. */
const GATEWAY_IMAGE = "alpine/socat:latest";

/** Label storing the port+aliases the sidecar was created with. */
const GATEWAY_CONFIG_LABEL = "silo.gateway.config";

/** True when this platform needs the sidecar (Docker Desktop VMs). */
export function needsGatewaySidecar(): boolean {
  return resolveGatewayMode() === "sidecar";
}

/** DNS aliases the sidecar must carry on the sandbox network. */
export function gatewayAliases(integrations: IntegrationConfig[]): string[] {
  const aliases = new Set<string>(["llm.gateway"]);
  for (const integration of integrations) {
    aliases.add(integration.gateway);
  }
  return [...aliases];
}

/** Deterministic signature so config drift triggers a sidecar rebuild. */
export function gatewayConfigSignature(
  proxyPort: number,
  integrations: IntegrationConfig[],
): string {
  return `${proxyPort}|${gatewayAliases(integrations).sort().join(",")}`;
}

/**
 * Idempotently start the gateway sidecar and attach it to the sandbox
 * network with the required DNS aliases. Reuses a running sidecar when its
 * recorded port/alias signature matches; replaces it otherwise.
 */
export async function ensureGatewaySidecar(
  proxyPort: number,
  integrations: IntegrationConfig[],
): Promise<void> {
  const aliases = gatewayAliases(integrations);
  const signature = gatewayConfigSignature(proxyPort, integrations);

  const existing = await execa(
    "docker",
    [
      "inspect",
      "--format",
      `{{.State.Running}} {{index .Config.Labels "${GATEWAY_CONFIG_LABEL}"}}`,
      GATEWAY_CONTAINER,
    ],
    { reject: false },
  );

  if (existing.exitCode === 0) {
    const output = existing.stdout.trim();
    const spaceIdx = output.indexOf(" ");
    const running = spaceIdx === -1 ? output : output.slice(0, spaceIdx);
    const label = spaceIdx === -1 ? "" : output.slice(spaceIdx + 1);

    if (label === signature) {
      if (running !== "true") {
        await execa("docker", ["start", GATEWAY_CONTAINER]);
      }
      // The sandbox network may have been recreated since the sidecar was
      // attached, so (re-)connecting is part of the idempotent path.
      await connectToSandboxNetwork(aliases);
      return;
    }

    // Port or integration aliases changed — replace the sidecar.
    await execa("docker", ["rm", "--force", GATEWAY_CONTAINER], { reject: false });
  }

  await execa("docker", [
    "run",
    "--detach",
    "--name", GATEWAY_CONTAINER,
    "--label", "managed-by=silo",
    "--label", `${GATEWAY_CONFIG_LABEL}=${signature}`,
    "--restart", "unless-stopped",
    // The default bridge gives the sidecar its route to the host; the
    // internal sandbox network is attached separately below.
    "--network", "bridge",
    "--add-host", "host.docker.internal:host-gateway",
    // The sidecar only relays TCP — harden it like the sandbox itself.
    "--user", "65534:65534",
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "64",
    "--memory", "64m",
    GATEWAY_IMAGE,
    `TCP-LISTEN:${proxyPort},fork,reuseaddr`,
    `TCP:host.docker.internal:${proxyPort}`,
  ]);

  await connectToSandboxNetwork(aliases);
}

/** Remove the sidecar container. Safe to call when it does not exist. */
export async function removeGatewaySidecar(): Promise<void> {
  await execa("docker", ["rm", "--force", GATEWAY_CONTAINER], { reject: false });
}

async function connectToSandboxNetwork(aliases: string[]): Promise<void> {
  const args = ["network", "connect"];
  for (const alias of aliases) {
    args.push("--alias", alias);
  }
  args.push(SILO_NETWORK, GATEWAY_CONTAINER);

  const result = await execa("docker", args, { reject: false });
  if (result.exitCode !== 0 && !/already exists/i.test(result.stderr)) {
    throw new Error(
      `Failed to attach gateway sidecar to "${SILO_NETWORK}": ${result.stderr}`,
    );
  }
}
