import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateFrameworkDockerfile } from "../../src/frameworks/docker-builder.js";

// Import definitions to populate registry
import "../../src/frameworks/definitions.js";
import { getFramework, listFrameworks } from "../../src/frameworks/registry.js";

describe("generateFrameworkDockerfile", () => {
  let tmpDir: string;
  let baseDockerfile: string;

  const BASE_DOCKERFILE = `FROM python:3.12-slim
RUN apt-get update
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
RUN mkdir -p /workspace && chown 1001:1001 /workspace
RUN mkdir -p /skills && chown 1001:1001 /skills
COPY silo_callbacks/ /usr/lib/python3/dist-packages/silo_callbacks/
USER agent
WORKDIR /workspace
ENTRYPOINT ["/entrypoint.sh"]
CMD ["tail", "-f", "/dev/null"]
`;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `silo-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    baseDockerfile = join(tmpDir, "Dockerfile");
    writeFileSync(baseDockerfile, BASE_DOCKERFILE);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("generates valid Dockerfile for CrewAI (pip framework)", () => {
    const crewai = getFramework("crewai")!;
    const outputPath = generateFrameworkDockerfile(crewai, baseDockerfile);

    expect(existsSync(outputPath)).toBe(true);

    const content = readFileSync(outputPath, "utf8");

    // Framework install should appear BEFORE 'USER agent'
    const userLineIdx = content.indexOf("USER agent");
    const pipInstallIdx = content.indexOf("pip install");

    expect(pipInstallIdx).toBeGreaterThan(-1);
    expect(pipInstallIdx).toBeLessThan(userLineIdx);

    // Packages should be listed
    expect(content).toContain("crewai");
    expect(content).toContain("crewai-tools");

    // Environment variables
    expect(content).toContain('ENV CREWAI_TELEMETRY="false"');

    // Original structure preserved
    expect(content).toContain("ENTRYPOINT");
    expect(content).toContain("USER agent");
  });

  it("generates valid Dockerfile for LangGraph (pip with multiple packages)", () => {
    const langgraph = getFramework("langgraph")!;
    const outputPath = generateFrameworkDockerfile(langgraph, baseDockerfile);
    const content = readFileSync(outputPath, "utf8");

    expect(content).toContain("langgraph");
    expect(content).toContain("langchain");
    expect(content).toContain("langchain-openai");
  });

  it("generates valid Dockerfile for OpenClaw (custom install)", () => {
    const openclaw = getFramework("openclaw")!;
    const outputPath = generateFrameworkDockerfile(openclaw, baseDockerfile);
    const content = readFileSync(outputPath, "utf8");

    // Custom dockerSnippet should be present
    expect(content).toContain("npm install -g openclaw");
    expect(content).toContain("COPY --from=node:22-bookworm-slim");
  });

  it("generates valid Dockerfile for Aider (simple pip)", () => {
    const aider = getFramework("aider")!;
    const outputPath = generateFrameworkDockerfile(aider, baseDockerfile);
    const content = readFileSync(outputPath, "utf8");

    expect(content).toContain("aider-chat");
    expect(content).toContain("pip install");
  });

  it("preserves USER agent ordering", () => {
    const crewai = getFramework("crewai")!;
    const outputPath = generateFrameworkDockerfile(crewai, baseDockerfile);
    const content = readFileSync(outputPath, "utf8");

    const lines = content.split("\n");
    const userIdx = lines.findIndex((l) => l.trim() === "USER agent");
    const pipIdx = lines.findIndex((l) => l.includes("pip install"));
    const entrypointIdx = lines.findIndex((l) => l.includes("ENTRYPOINT"));

    // Install must be before USER, ENTRYPOINT must be after USER
    expect(pipIdx).toBeLessThan(userIdx);
    expect(entrypointIdx).toBeGreaterThan(userIdx);
  });

  it("throws when base Dockerfile has no USER agent line", () => {
    const badDockerfile = join(tmpDir, "Dockerfile.bad");
    writeFileSync(badDockerfile, "FROM python:3.12-slim\nRUN echo hello\n");

    const crewai = getFramework("crewai")!;
    expect(() => generateFrameworkDockerfile(crewai, badDockerfile)).toThrow(
      /Cannot find.*USER agent/,
    );
  });

  it("includes system deps for SWE-Agent", () => {
    const swe = getFramework("swe-agent")!;
    const outputPath = generateFrameworkDockerfile(swe, baseDockerfile);
    const content = readFileSync(outputPath, "utf8");

    expect(content).toContain("build-essential");
    expect(content).toContain("apt-get install");
    expect(content).toContain("swe-agent");
  });

  it("generates browser-capable framework Dockerfile variant", () => {
    const openclaw = getFramework("openclaw")!;
    const outputPath = generateFrameworkDockerfile(openclaw, baseDockerfile, {
      browser: true,
    });
    const content = readFileSync(outputPath, "utf8");

    expect(outputPath).toContain("openclaw-browser");
    expect(content).toContain("Capability: browser automation");
    expect(content).toContain("chromium");
    expect(content).toContain("/usr/local/bin/silo-chromium");
    expect(content).toContain("ln -sf /usr/local/bin/silo-chromium /usr/local/bin/google-chrome");
    expect(content).toContain('ENV CHROME_BIN="/usr/local/bin/silo-chromium"');
    expect(content).toContain('ENV PUPPETEER_EXECUTABLE_PATH="/usr/local/bin/silo-chromium"');
    expect(content).toContain("--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage");
    expect(content).toContain("npm install -g openclaw@latest");
    expect(content).toContain("Node.js 22.19+ required");
    expect(content).not.toContain("setup_22.x");
  });

  it("generates browser-capable Dockerfile variants for every framework", () => {
    for (const framework of listFrameworks()) {
      const outputPath = generateFrameworkDockerfile(framework, baseDockerfile, {
        browser: true,
      });
      const content = readFileSync(outputPath, "utf8");

      const browserLayerIdx = content.indexOf("Capability: browser automation");
      const frameworkLayerIdx = content.indexOf(`# Framework: ${framework.name}`);

      expect(outputPath).toContain(`${framework.id}-browser`);
      expect(browserLayerIdx).toBeGreaterThan(-1);
      expect(frameworkLayerIdx).toBeGreaterThan(-1);
      expect(browserLayerIdx).toBeLessThan(frameworkLayerIdx);
      expect(content).toContain('ENV SILO_BROWSER="1"');
      expect(content).toContain("/usr/local/bin/silo-chromium");
      expect(content).toContain('ENV PUPPETEER_SKIP_DOWNLOAD="true"');

      if (framework.install.method === "pip") {
        for (const pkg of framework.install.packages) {
          expect(content).toContain(pkg);
        }
      }

      if (framework.install.method === "custom") {
        expect(content).toContain(framework.install.dockerSnippet);
      }
    }
  });
});
