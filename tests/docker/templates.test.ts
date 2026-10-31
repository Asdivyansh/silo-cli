/**
 * Tests for Docker runtime template security flags.
 *
 * Snapshot-style tests that verify the `buildRunFlags()` function always
 * includes every required security hardening flag. Catching accidental
 * removal of a security flag (e.g. --cap-drop ALL) is the primary goal.
 */
import { describe, it, expect } from "vitest";
import { buildRunFlags, SILO_NETWORK } from "../../src/docker/templates.js";
import type { SandboxConfig, ProxyConfig, IntegrationConfig } from "../../src/config/schema.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseSandbox: SandboxConfig = {
  image: "silo-sandbox:latest",
  containerName: "silo-test",
  workspacePath: "/home/user/project",
  cpuLimit: "1.0",
  memoryLimit: "512m",
};

const baseProxy: ProxyConfig = {
  port: 8199,
  running: true,
  autoOpenLogs: true,
};

// ---------------------------------------------------------------------------
// Security hardening tests
// ---------------------------------------------------------------------------

describe("buildRunFlags security hardening", () => {
  const flags = buildRunFlags(baseSandbox, baseProxy);
  const joined = flags.join(" ");

  it("runs as non-root user 1001:1001", () => {
    expect(flags).toContain("--user");
    const userIdx = flags.indexOf("--user");
    expect(flags[userIdx + 1]).toBe("1001:1001");
  });

  it("enables read-only root filesystem", () => {
    expect(flags).toContain("--read-only");
  });

  it("provides a writable /tmp with noexec,nosuid", () => {
    expect(flags).toContain("--tmpfs");
    const tmpfsIdx = flags.indexOf("--tmpfs");
    const tmpfsValue = flags[tmpfsIdx + 1]!;
    expect(tmpfsValue).toContain("/tmp");
    expect(tmpfsValue).toContain("noexec");
    expect(tmpfsValue).toContain("nosuid");
  });

  it("drops ALL Linux capabilities", () => {
    expect(flags).toContain("--cap-drop");
    const capIdx = flags.indexOf("--cap-drop");
    expect(flags[capIdx + 1]).toBe("ALL");
  });

  it("prevents privilege escalation via setuid/setgid", () => {
    expect(flags).toContain("--security-opt");
    const secIdx = flags.indexOf("--security-opt");
    expect(flags[secIdx + 1]).toBe("no-new-privileges");
  });

  it("limits PIDs to 128 (fork bomb protection)", () => {
    expect(flags).toContain("--pids-limit");
    const pidIdx = flags.indexOf("--pids-limit");
    expect(flags[pidIdx + 1]).toBe("128");
  });

  it("uses the internal sandbox network", () => {
    expect(flags).toContain("--network");
    const netIdx = flags.indexOf("--network");
    expect(flags[netIdx + 1]).toBe(SILO_NETWORK);
  });

  it("adds llm.gateway host alias for proxy access", () => {
    expect(joined).toContain("llm.gateway:host-gateway");
  });

  it("sets CPU and memory limits", () => {
    expect(flags).toContain("--cpus");
    expect(flags).toContain("--memory");
    const cpuIdx = flags.indexOf("--cpus");
    const memIdx = flags.indexOf("--memory");
    expect(flags[cpuIdx + 1]).toBe("1.0");
    expect(flags[memIdx + 1]).toBe("512m");
  });
});

// ---------------------------------------------------------------------------
// Proxy environment variables
// ---------------------------------------------------------------------------

describe("buildRunFlags proxy environment", () => {
  const flags = buildRunFlags(baseSandbox, baseProxy);

  it("sets http_proxy and https_proxy for container HTTP clients", () => {
    const envFlags = flags.filter((_, i) => i > 0 && flags[i - 1] === "--env");
    const proxyUrl = `http://llm.gateway:${baseProxy.port}`;

    expect(envFlags).toContain(`http_proxy=${proxyUrl}`);
    expect(envFlags).toContain(`https_proxy=${proxyUrl}`);
    expect(envFlags).toContain(`HTTP_PROXY=${proxyUrl}`);
    expect(envFlags).toContain(`HTTPS_PROXY=${proxyUrl}`);
  });

  it("sets no_proxy for localhost bypass", () => {
    const envFlags = flags.filter((_, i) => i > 0 && flags[i - 1] === "--env");
    const noProxy = envFlags.find((f) => f.startsWith("no_proxy="));
    expect(noProxy).toBeDefined();
    expect(noProxy).toContain("localhost");
    expect(noProxy).toContain("127.0.0.1");
  });

  it("marks the container with SILO_SANDBOX=1", () => {
    const envFlags = flags.filter((_, i) => i > 0 && flags[i - 1] === "--env");
    expect(envFlags).toContain("SILO_SANDBOX=1");
  });
});

// ---------------------------------------------------------------------------
// Opt-in host mounts
// ---------------------------------------------------------------------------

describe("buildRunFlags host mounts", () => {
  it("adds explicit host mounts under /host", () => {
    const flags = buildRunFlags(
      {
        ...baseSandbox,
        hostMounts: [
          { source: "/Users/test/Desktop", target: "/host/Desktop", mode: "rw" },
          { source: "/Users/test/Downloads", target: "/host/Downloads", mode: "ro" },
        ],
      },
      baseProxy,
    );
    const volumeFlags = flags.filter((_, i) => i > 0 && flags[i - 1] === "--volume");
    const envFlags = flags.filter((_, i) => i > 0 && flags[i - 1] === "--env");

    expect(volumeFlags).toContain("/Users/test/Desktop:/host/Desktop:rw");
    expect(volumeFlags).toContain("/Users/test/Downloads:/host/Downloads:ro");
    expect(envFlags).toContain("SILO_HOST_MOUNTS=/host/Desktop,/host/Downloads");
    expect(envFlags).toContain("SILO_HOST_DESKTOP=/host/Desktop");
  });
});

// ---------------------------------------------------------------------------
// Framework metadata
// ---------------------------------------------------------------------------

describe("buildRunFlags framework support", () => {
  it("adds framework label and env var", () => {
    const flags = buildRunFlags(baseSandbox, baseProxy, [], {
      id: "crewai",
      envVars: { CREWAI_API_KEY: "test" },
    });
    const envFlags = flags.filter((_, i) => i > 0 && flags[i - 1] === "--env");
    const labelFlags = flags.filter((_, i) => i > 0 && flags[i - 1] === "--label");

    expect(envFlags).toContain("SILO_FRAMEWORK=crewai");
    expect(envFlags).toContain("CREWAI_API_KEY=test");
    expect(labelFlags).toContain("silo.framework=crewai");
  });

  it("works without framework metadata", () => {
    const flags = buildRunFlags(baseSandbox, baseProxy);
    const envFlags = flags.filter((_, i) => i > 0 && flags[i - 1] === "--env");
    expect(envFlags.some((f) => f.startsWith("SILO_FRAMEWORK="))).toBe(false);
  });

  it("supports framework-specific tmpfs size overrides", () => {
    const flags = buildRunFlags(baseSandbox, baseProxy, [], {
      id: "openclaw",
      tmpfsMounts: ["/home/agent"],
      tmpfsMountSizes: { "/home/agent": "256m" },
    });
    const tmpfsFlags = flags.filter((_, i) => i > 0 && flags[i - 1] === "--tmpfs");

    expect(tmpfsFlags).toContain("/home/agent:size=256m,uid=1001,gid=1001,nosuid");
  });
});

describe("buildRunFlags browser profile", () => {
  it("adds browser tmpfs, shm, and executable env vars only when requested", () => {
    const flags = buildRunFlags(baseSandbox, baseProxy, [], {
      id: "openclaw",
      browser: true,
    });
    const envFlags = flags.filter((_, i) => i > 0 && flags[i - 1] === "--env");
    const tmpfsFlags = flags.filter((_, i) => i > 0 && flags[i - 1] === "--tmpfs");

    expect(flags).toContain("--shm-size");
    expect(flags[flags.indexOf("--shm-size") + 1]).toBe("512m");
    expect(tmpfsFlags).toContain("/browser-cache:size=512m,uid=1001,gid=1001,nosuid");
    expect(tmpfsFlags).toContain("/browser-profile:size=256m,uid=1001,gid=1001,nosuid");
    expect(tmpfsFlags).toContain("/browser-downloads:size=256m,uid=1001,gid=1001,nosuid");
    expect(envFlags).toContain("SILO_BROWSER=1");
    expect(envFlags).toContain("CHROME_BIN=/usr/local/bin/silo-chromium");
    expect(envFlags).toContain("PUPPETEER_EXECUTABLE_PATH=/usr/local/bin/silo-chromium");
    expect(envFlags).toContain("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1");
  });

  it("does not add browser runtime flags by default", () => {
    const flags = buildRunFlags(baseSandbox, baseProxy);
    const joined = flags.join(" ");

    expect(joined).not.toContain("SILO_BROWSER=1");
    expect(flags).not.toContain("--shm-size");
  });
});

// ---------------------------------------------------------------------------
// Integration gateway aliases
// ---------------------------------------------------------------------------

describe("buildRunFlags integration gateways", () => {
  const integrations: IntegrationConfig[] = [
    {
      name: "slack",
      baseUrl: "https://slack.com/api",
      gateway: "slack.gateway",
      authType: "bearer",
      token: "xoxb-test",
    },
    {
      name: "github",
      baseUrl: "https://api.github.com",
      gateway: "github.gateway",
      authType: "header",
      token: "ghp_test",
      authHeader: "authorization",
    },
  ];

  it("adds host aliases for each integration", () => {
    const flags = buildRunFlags(baseSandbox, baseProxy, integrations);
    const joined = flags.join(" ");
    expect(joined).toContain("slack.gateway:host-gateway");
    expect(joined).toContain("github.gateway:host-gateway");
  });

  it("keeps integration gateways when browser mode is enabled", () => {
    const flags = buildRunFlags(baseSandbox, baseProxy, integrations, {
      id: "openclaw",
      browser: true,
    });
    const joined = flags.join(" ");

    expect(joined).toContain("slack.gateway:host-gateway");
    expect(joined).toContain("github.gateway:host-gateway");
    expect(joined).toContain("SILO_BROWSER=1");
    expect(flags[flags.length - 1]).toBe("silo-sandbox:latest");
  });

  it("works with no integrations", () => {
    const flags = buildRunFlags(baseSandbox, baseProxy, []);
    // Should not throw and should still have basic flags
    expect(flags).toContain("--cap-drop");
  });
});

// ---------------------------------------------------------------------------
// Image placement
// ---------------------------------------------------------------------------

describe("buildRunFlags image placement", () => {
  it("places the image tag as the last element", () => {
    const flags = buildRunFlags(baseSandbox, baseProxy);
    expect(flags[flags.length - 1]).toBe("silo-sandbox:latest");
  });
});

// ---------------------------------------------------------------------------
// Gateway modes (Docker Desktop sidecar vs Linux host-gateway)
// ---------------------------------------------------------------------------

describe("buildRunFlags gateway modes", () => {
  const integrations: IntegrationConfig[] = [
    {
      name: "slack",
      baseUrl: "https://slack.com/api",
      gateway: "slack.gateway",
      authType: "bearer",
      token: "xoxb-test",
    },
  ];

  it("defaults to host-gateway mode with /etc/hosts aliases", () => {
    const flags = buildRunFlags(baseSandbox, baseProxy, integrations);
    const joined = flags.join(" ");
    expect(joined).toContain("llm.gateway:host-gateway");
    expect(joined).toContain("slack.gateway:host-gateway");
  });

  it("omits all --add-host aliases in sidecar mode (DNS aliases come from silo-gateway)", () => {
    const flags = buildRunFlags(baseSandbox, baseProxy, integrations, undefined, "sidecar");
    expect(flags).not.toContain("--add-host");
    expect(flags.join(" ")).not.toContain("host-gateway");
  });

  it("keeps the internal network and proxy env vars in sidecar mode", () => {
    const flags = buildRunFlags(baseSandbox, baseProxy, integrations, undefined, "sidecar");
    const netIdx = flags.indexOf("--network");
    expect(flags[netIdx + 1]).toBe(SILO_NETWORK);

    const envFlags = flags.filter((_, i) => i > 0 && flags[i - 1] === "--env");
    expect(envFlags).toContain(`http_proxy=http://llm.gateway:${baseProxy.port}`);
    expect(envFlags).toContain("no_proxy=localhost,127.0.0.1,::1,llm.gateway");
  });

  it("preserves security hardening in sidecar mode", () => {
    const flags = buildRunFlags(baseSandbox, baseProxy, [], undefined, "sidecar");
    expect(flags).toContain("--read-only");
    expect(flags).toContain("--cap-drop");
    expect(flags[flags.length - 1]).toBe("silo-sandbox:latest");
  });
});
