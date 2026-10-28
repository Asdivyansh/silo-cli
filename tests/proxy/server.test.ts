/**
 * Tests for the inference proxy server.
 *
 * These tests spin up a real HTTP server on a random port and make actual
 * HTTP requests to it. All upstream calls are intercepted via Vitest mocks
 * so no network traffic leaves the test runner.
 *
 * Coverage:
 *  - Health endpoint (/_silo/health)
 *  - LLM gateway detection (isLlmGateway)
 *  - CONNECT tunnel policy enforcement (allow / deny)
 *  - HTTP request policy enforcement (allow / deny)
 *  - Integration gateway routing identification
 *  - Policy verdict evaluation (allow / deny / interception)
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  vi,
} from "vitest";
import {
  createServer,
  request as makeHttpRequest,
  type IncomingMessage,
  type Server,
} from "node:http";
import { connect as netConnect, type AddressInfo } from "node:net";
import {
  isAuthorizedControlRequest,
  isTrustedSource,
  startProxyServer,
  stopProxyServer,
} from "../../src/proxy/server.js";
import type { CompiledPolicy } from "../../src/policy/engine.js";
import type { IntegrationConfig } from "../../src/config/schema.js";

// ---------------------------------------------------------------------------
// Mocks — prevent any real upstream calls or audit writes
// ---------------------------------------------------------------------------

vi.mock("../../src/audit/audit.js", () => ({
  appendAuditEntry: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/audit/tool-calls.js", () => ({
  extractToolCalls: vi.fn().mockReturnValue([]),
}));

vi.mock("../../src/audit/traces.js", () => ({
  processTrace: vi.fn().mockResolvedValue({ traceId: "t1", event: "test" }),
}));

vi.mock("../../src/proxy/interceptor.js", () => ({
  promptApproveOrDeny: vi.fn().mockResolvedValue("deny"),
  onPolicyUpdated: vi.fn(),
  getPendingPrompts: vi.fn().mockReturnValue([{ id: "p1", method: "GET", host: "example.com", url: "http://example.com/" }]),
  registerPromptPoll: vi.fn(),
  submitPromptDecision: vi.fn().mockReturnValue(true),
}));

vi.mock("../../src/integrations/resolver.js", () => ({
  resolveIntegrationTarget: vi.fn().mockReturnValue({
    baseUrl: "https://slack.com/api",
    authHeaders: { authorization: "Bearer xoxb-test" },
    queryParams: {},
  }),
  findIntegration: vi.fn().mockReturnValue(null),
  isIntegrationGateway: vi.fn().mockReturnValue(false),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find a random free port to avoid conflicts. */
let TEST_PORT = 0;

function makePolicy(defaultVerdict: "allow" | "deny"): CompiledPolicy {
  return {
    source: {
      version: "1",
      name: "test",
      default: defaultVerdict,
      rules: [],
    },
    compiledRules: [],
  };
}

function httpGet(
  path: string,
  headers: Record<string, string> = {},
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = makeHttpRequest(
      {
        hostname: "127.0.0.1",
        port: TEST_PORT,
        path,
        method: "GET",
        headers: { host: "127.0.0.1", ...headers },
      },
      (res: IncomingMessage) => {
        let body = "";
        res.on("data", (c: Buffer) => { body += c.toString(); });
        res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function httpPost(
  path: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = makeHttpRequest(
      {
        hostname: "127.0.0.1",
        port: TEST_PORT,
        path,
        method: "POST",
        headers: {
          host: "127.0.0.1",
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
          ...headers,
        },
      },
      (res: IncomingMessage) => {
        let buf = "";
        res.on("data", (c: Buffer) => { buf += c.toString(); });
        res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body: buf }));
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/**
 * Send raw bytes to the proxy and collect everything it writes back until it
 * closes the connection (or `timeoutMs` passes). Used for requests a normal
 * HTTP client refuses to build (odd schemes, CONNECT).
 */
function rawRequest(payload: string, timeoutMs = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(TEST_PORT, "127.0.0.1");
    let data = "";
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(data);
    }, timeoutMs);
    socket.on("data", (c: Buffer) => { data += c.toString(); });
    socket.on("close", () => {
      clearTimeout(timer);
      resolve(data);
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      if (data) resolve(data);
      else reject(err);
    });
    socket.write(payload);
  });
}

function connectRequest(target: string): Promise<string> {
  return rawRequest(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
}

const CONTROL_TOKEN = "test-control-token";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const denyPolicy = makePolicy("deny");
const allowPolicy = makePolicy("allow");
let currentPolicy: CompiledPolicy = denyPolicy;

// ---------------------------------------------------------------------------
// Source trust guard
// ---------------------------------------------------------------------------

describe("isTrustedSource", () => {
  it("trusts loopback clients", () => {
    expect(isTrustedSource("127.0.0.1")).toBe(true);
    expect(isTrustedSource("::1")).toBe(true);
    expect(isTrustedSource("::ffff:127.0.0.1")).toBe(true);
  });

  it("trusts clients inside configured Docker network CIDRs", () => {
    expect(isTrustedSource("172.20.0.12", ["172.20.0.0/16"])).toBe(true);
    expect(isTrustedSource("192.168.65.4", ["192.168.65.0/24"])).toBe(true);
  });

  it("rejects private LAN ranges unless they match the configured Docker CIDRs", () => {
    expect(isTrustedSource("192.168.1.50")).toBe(false);
    expect(isTrustedSource("172.18.0.2", ["172.19.0.0/16"])).toBe(false);
    expect(isTrustedSource("10.0.0.8", ["172.20.0.0/16"])).toBe(false);
  });
});

beforeAll(async () => {
  // Pick a random port in a range unlikely to conflict
  TEST_PORT = 19000 + Math.floor(Math.random() * 1000);

  await startProxyServer({
    port: TEST_PORT,
    getLlm: () => ({ provider: "openai", apiKey: "sk-test", model: "gpt-4o" }),
    getCompiledPolicy: () => currentPolicy,
    getIntegrations: () => [] as IntegrationConfig[],
    controlToken: CONTROL_TOKEN,
  });
});

afterEach(() => {
  currentPolicy = denyPolicy;
});

afterAll(async () => {
  await stopProxyServer();
});

// ---------------------------------------------------------------------------
// Health endpoint
// ---------------------------------------------------------------------------

describe("/_silo/health", () => {
  it("returns 200 with status:ok", async () => {
    const { statusCode, body } = await httpGet("/_silo/health", {
      host: "127.0.0.1",
    });
    expect(statusCode).toBe(200);
    const json = JSON.parse(body) as { status: string; pid: number; uptimeMs: number };
    expect(json.status).toBe("ok");
    expect(json.pid).toBe(process.pid);
    expect(typeof json.uptimeMs).toBe("number");
  });

  it("also responds to /_silo/health as a full URL path", async () => {
    const { statusCode } = await httpGet(
      `http://127.0.0.1:${TEST_PORT}/_silo/health`,
      { host: "127.0.0.1" },
    );
    expect(statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Trace ingestion endpoint
// ---------------------------------------------------------------------------

describe("POST /_silo/traces", () => {
  it("accepts a valid trace and returns 200", async () => {
    const trace = JSON.stringify({
      framework: "crewai",
      event: "agent_start",
      agent: "Researcher",
      timestamp: new Date().toISOString(),
    });

    const { statusCode, body } = await httpPost(
      `http://127.0.0.1:${TEST_PORT}/_silo/traces`,
      trace,
      { host: "127.0.0.1" },
    );

    expect(statusCode).toBe(200);
    const json = JSON.parse(body) as { accepted: number };
    expect(json.accepted).toBe(1);
  });

  it("returns 400 on invalid JSON", async () => {
    const { statusCode } = await httpPost(
      `http://127.0.0.1:${TEST_PORT}/_silo/traces`,
      "not-json",
      { host: "127.0.0.1" },
    );
    expect(statusCode).toBe(400);
  });

  it("accepts an array of traces", async () => {
    const traces = JSON.stringify([
      { framework: "crewai", event: "task_start", timestamp: new Date().toISOString() },
      { framework: "crewai", event: "task_end", timestamp: new Date().toISOString() },
    ]);

    const { statusCode, body } = await httpPost(
      `http://127.0.0.1:${TEST_PORT}/_silo/traces`,
      traces,
      { host: "127.0.0.1" },
    );

    expect(statusCode).toBe(200);
    const json = JSON.parse(body) as { accepted: number };
    expect(json.accepted).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Policy enforcement (HTTP)
// ---------------------------------------------------------------------------

describe("HTTP policy enforcement", () => {
  it("blocks a denied host with 403", async () => {
    // The default policy is deny; interceptor mock returns "deny"
    const { statusCode, body } = await httpGet(
      "http://evil.example.com/exfiltrate",
      { host: "evil.example.com" },
    );
    expect(statusCode).toBe(403);
    expect(body).toContain("Blocked by SILO policy");
  });

  it("includes the host name in the blocked response", async () => {
    const { body } = await httpGet(
      "http://evil.example.com/path",
      { host: "evil.example.com" },
    );
    expect(body).toContain("evil.example.com");
  });
});

// ---------------------------------------------------------------------------
// Server start/stop idempotency
// ---------------------------------------------------------------------------

describe("startProxyServer", () => {
  it("is idempotent — calling start when already running resolves immediately", async () => {
    // Should not throw or hang
    await expect(
      startProxyServer({
        port: TEST_PORT,
        getLlm: () => ({ provider: "openai", apiKey: "sk-test", model: "gpt-4o" }),
        getCompiledPolicy: () => denyPolicy,
        getIntegrations: () => [] as IntegrationConfig[],
      }),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// CompiledPolicy getter contract
// ---------------------------------------------------------------------------

describe("getCompiledPolicy", () => {
  it("is called for each policy-gated request", async () => {
    // Track that the getter in the test server's opts is actually invoked.
    // We can't easily spy on the inner server state, but we CAN verify that
    // a request to non-gateway host goes through the interceptor
    // (which is only reached after the getter is called).
    const { promptApproveOrDeny } = await import("../../src/proxy/interceptor.js");
    const spy = vi.mocked(promptApproveOrDeny);
    spy.mockClear();

    await httpGet("http://gated.example.com/path", { host: "gated.example.com" });

    // interceptor is only reached if the getter was invoked and returned deny
    expect(spy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Prompts API endpoints
// ---------------------------------------------------------------------------

describe("Prompts API endpoints", () => {
  const auth = { "x-silo-control-token": CONTROL_TOKEN };

  it("GET /_silo/prompts returns pending prompts with the control token", async () => {
    const { statusCode, body } = await httpGet("/_silo/prompts", auth);
    expect(statusCode).toBe(200);
    const json = JSON.parse(body);
    expect(json).toBeInstanceOf(Array);
    expect(json[0].id).toBe("p1");
  });

  it("POST /_silo/prompts/:id/decision submits decision with the control token", async () => {
    const { submitPromptDecision } = await import("../../src/proxy/interceptor.js");
    vi.mocked(submitPromptDecision).mockClear();

    const { statusCode, body } = await httpPost(
      "/_silo/prompts/p1/decision",
      JSON.stringify({ decision: "allow_once" }),
      auth,
    );
    expect(statusCode).toBe(200);
    expect(JSON.parse(body).success).toBe(true);
    expect(vi.mocked(submitPromptDecision)).toHaveBeenCalledWith("p1", "allow_once");
  });

  it("rejects GET without a token and does not mark a listener active", async () => {
    const { registerPromptPoll } = await import("../../src/proxy/interceptor.js");
    vi.mocked(registerPromptPoll).mockClear();

    const { statusCode, body } = await httpGet("/_silo/prompts");
    expect(statusCode).toBe(403);
    expect(body).not.toContain("p1");
    expect(vi.mocked(registerPromptPoll)).not.toHaveBeenCalled();
  });

  it("rejects a wrong token", async () => {
    const { statusCode } = await httpGet("/_silo/prompts", {
      "x-silo-control-token": "guessed",
    });
    expect(statusCode).toBe(403);
  });

  it("rejects a decision without a token and never applies it", async () => {
    const { submitPromptDecision } = await import("../../src/proxy/interceptor.js");
    vi.mocked(submitPromptDecision).mockClear();

    const { statusCode } = await httpPost(
      "/_silo/prompts/p1/decision",
      JSON.stringify({ decision: "allow_always" }),
    );
    expect(statusCode).toBe(403);
    expect(vi.mocked(submitPromptDecision)).not.toHaveBeenCalled();
  });

  it("does not serve the prompt endpoints under an absolute-form proxy URL", async () => {
    // A sandbox client would send this through the proxy; it must never be
    // handled as a control request, even with a (leaked) token.
    const { statusCode } = await httpGet(
      "http://anything.example/_silo/prompts",
      { host: "anything.example", ...auth },
    );
    expect(statusCode).not.toBe(200);
  });

  it("rejects decision values other than allow_once / allow_always / deny", async () => {
    const { submitPromptDecision } = await import("../../src/proxy/interceptor.js");
    vi.mocked(submitPromptDecision).mockClear();

    for (const decision of ["allow", "ALLOW_ALWAYS", "", 1, null]) {
      const { statusCode } = await httpPost(
        "/_silo/prompts/p1/decision",
        JSON.stringify({ decision }),
        auth,
      );
      expect(statusCode).toBe(400);
    }
    expect(vi.mocked(submitPromptDecision)).not.toHaveBeenCalled();
  });
});

describe("isAuthorizedControlRequest", () => {
  it("requires both a loopback source and the matching token", () => {
    expect(isAuthorizedControlRequest("127.0.0.1", "tok", "tok")).toBe(true);
    expect(isAuthorizedControlRequest("::ffff:127.0.0.1", "tok", "tok")).toBe(true);
    expect(isAuthorizedControlRequest("127.0.0.1", "nope", "tok")).toBe(false);
    expect(isAuthorizedControlRequest("127.0.0.1", "tok", undefined)).toBe(false);
  });

  it("rejects sandbox-network sources even with the right token", () => {
    expect(isAuthorizedControlRequest("172.20.0.5", "tok", "tok")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Policy target must match the forwarded target
// ---------------------------------------------------------------------------

describe("HTTP target consistency", () => {
  it("rejects non-http schemes instead of policy-checking the Host header", async () => {
    // Previously: policy saw Host "localhost" (allowed) while the request was
    // forwarded to evil.example.com.
    currentPolicy = allowPolicy;
    const { promptApproveOrDeny } = await import("../../src/proxy/interceptor.js");
    vi.mocked(promptApproveOrDeny).mockClear();

    const response = await rawRequest(
      "GET httpx://evil.example.com/exfil HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
    );
    expect(response).toMatch(/^HTTP\/1\.1 400/);
    expect(vi.mocked(promptApproveOrDeny)).not.toHaveBeenCalled();
  });

  it("policy-checks the URL host for an upper-case scheme, not the Host header", async () => {
    const response = await rawRequest(
      "GET HTTP://evil.example.com/exfil HTTP/1.1\r\nHost: allowed.example\r\nConnection: close\r\n\r\n",
    );
    expect(response).toMatch(/^HTTP\/1\.1 403/);
    expect(response).toContain("Blocked by SILO policy: evil.example.com");
  });

  it("rejects origin-form requests with no Host header", async () => {
    const response = await rawRequest("GET /some/path HTTP/1.0\r\n\r\n");
    expect(response).toMatch(/^HTTP\/1\.1 400/);
  });
});

// ---------------------------------------------------------------------------
// Host loopback is never reachable, whatever the policy says
// ---------------------------------------------------------------------------

describe("host-loopback protection", () => {
  let canary: Server;
  let canaryPort = 0;
  let canaryHits = 0;

  beforeAll(async () => {
    canary = createServer((_req, res) => {
      canaryHits++;
      res.end("host secret");
    });
    await new Promise<void>((resolve) => canary.listen(0, "127.0.0.1", resolve));
    canaryPort = (canary.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => canary.close(() => resolve()));
  });

  it.each([
    ["127.0.0.1", () => `http://127.0.0.1:${canaryPort}/`],
    ["localhost", () => `http://localhost:${canaryPort}/`],
    ["decimal IPv4", () => `http://2130706433:${canaryPort}/`],
    ["short IPv4", () => `http://127.1:${canaryPort}/`],
    ["0.0.0.0", () => `http://0.0.0.0:${canaryPort}/`],
    ["::1", () => `http://[::1]:${canaryPort}/`],
    ["*.localhost", () => `http://app.localhost:${canaryPort}/`],
  ])("blocks plain HTTP to %s even under an allow-all policy", async (_label, url) => {
    currentPolicy = allowPolicy;
    canaryHits = 0;
    const target = url();
    const { statusCode, body } = await httpGet(target, { host: new URL(target).host });
    expect(statusCode).toBe(403);
    expect(body).toContain("host loopback");
    expect(canaryHits).toBe(0);
  });

  it.each([
    ["127.0.0.1", () => `127.0.0.1:${canaryPort}`],
    ["localhost", () => `localhost:${canaryPort}`],
    ["LOCALHOST", () => `LOCALHOST:${canaryPort}`],
    ["::1", () => `[::1]:${canaryPort}`],
    ["127.1 (resolved via DNS lookup)", () => `127.1:${canaryPort}`],
  ])("blocks CONNECT to %s even under an allow-all policy", async (_label, target) => {
    currentPolicy = allowPolicy;
    canaryHits = 0;
    const response = await connectRequest(target());
    expect(response).toMatch(/^HTTP\/1\.1 403/);
    expect(response).toContain("host loopback");
    expect(response).not.toContain("200 Connection Established");
  });

  it("keeps serving the proxy's own routes to loopback clients", async () => {
    // Loopback blocking applies to proxied destinations, not to clients of
    // the proxy: the health endpoint on 127.0.0.1 keeps working.
    const { statusCode } = await httpGet("/_silo/health");
    expect(statusCode).toBe(200);
  });
});
