/**
 * Inference Proxy Server
 *
 * A lightweight HTTP proxy that runs on the host machine. All outbound
 * traffic from the sandboxed agent is routed through this server.
 *
 * Key responsibilities:
 *  1. Route requests to `llm.gateway` → real LLM provider, injecting
 *     the user's actual API key (which never enters the container).
 *  2. Evaluate every other request against the active policy; block denied
 *     hosts and optionally prompt the operator via the interceptor.
 *  3. Support CONNECT tunnels for policy-allowed HTTPS destinations.
 *  4. Stream responses without buffering so SSE/chunked LLM outputs work.
 */
import {
  createServer,
  request as makeHttpRequest,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from "node:http";
import { request as makeHttpsRequest } from "node:https";
import { createConnection, type Socket } from "node:net";
import { URL } from "node:url";
import { randomUUID } from "node:crypto";
import { log } from "../utils/logger.js";
import { resolveProviderTarget, STRIPPED_REQUEST_HEADERS } from "./provider.js";
import { promptApproveOrDeny } from "./interceptor.js";
import type { LLMConfig } from "../config/schema.js";
import type { IntegrationConfig } from "../config/schema.js";
import type { CompiledPolicy } from "../policy/engine.js";
import { evaluateCompiled } from "../policy/engine.js";
import { appendAuditEntry } from "../audit/audit.js";
import { extractErrorPreview, extractLlmMessages } from "../audit/llm-messages.js";
import { extractToolCalls, extractTokenUsage } from "../audit/tool-calls.js";
import { processTrace, type IncomingTrace } from "../audit/traces.js";
import {
  resolveIntegrationTarget,
  findIntegration,
  isIntegrationGateway,
} from "../integrations/resolver.js";
import {
  resolveProxyTarget,
  normaliseHostname,
  isLoopbackHostname,
  guardedLookup,
  LOOPBACK_BLOCKED_CODE,
} from "./target.js";
import { CONTROL_TOKEN_HEADER, controlTokenMatches } from "./control-token.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProxyServerOptions {
  port: number;
  getLlm: () => LLMConfig;
  /** Docker network CIDRs allowed to call the proxy, in addition to loopback. */
  trustedSourceCidrs?: string[];
  /** Pre-compiled policy reference — compiled once on load/reload for O(n) evaluation */
  getCompiledPolicy: () => CompiledPolicy;
  /** Configured integrations — the daemon reads these from the config */
  getIntegrations: () => IntegrationConfig[];
  /**
   * Secret required on the operator-only `/_silo/prompts` endpoints.
   * When unset, those endpoints are disabled.
   */
  controlToken?: string;
}

const PROMPT_DECISIONS = new Set(["allow_once", "allow_always", "deny"]);
const PROMPT_DECISION_PATH = /^\/_silo\/prompts\/([A-Za-z0-9-]+)\/decision$/;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let _server: Server | null = null;
let _startedAt: number = Date.now();

/**
 * Check whether a remote IP address is from a trusted source.
 * Trusted sources:
 *   - 127.x.x.x / ::1 / ::ffff:127.x  (loopback — silo run, health checks)
 *   - IPs inside the configured SILO Docker network CIDR(s)
 * Everything else (LAN peers, Wi-Fi neighbours, internet) is rejected, even
 * when it uses RFC1918 private address space.
 */
export function isTrustedSource(
  remoteAddress: string | undefined,
  trustedSourceCidrs: string[] = [],
): boolean {
  if (!remoteAddress) return false;
  // Normalise IPv6-mapped IPv4 (e.g. ::ffff:127.0.0.1 → 127.0.0.1)
  const ip = remoteAddress.replace(/^::ffff:/, "");
  if (ip === "::1" || ip.startsWith("127.")) return true;
  return trustedSourceCidrs.some((cidr) => ipv4MatchesCidr(ip, cidr));
}

/**
 * Check whether a request may use the operator-only control endpoints.
 * Requires a loopback source *and* the daemon's control token: the source
 * check alone is not enough, because Docker Desktop delivers container
 * traffic to host services from loopback.
 */
export function isAuthorizedControlRequest(
  remoteAddress: string | undefined,
  providedToken: string | string[] | undefined,
  expectedToken: string | undefined,
): boolean {
  if (!isTrustedSource(remoteAddress)) return false;
  return controlTokenMatches(expectedToken, providedToken);
}

function ipv4MatchesCidr(ip: string, cidr: string): boolean {
  const ipInt = ipv4ToInt(ip);
  if (ipInt === null) return false;

  if (!cidr.includes("/")) {
    const exact = ipv4ToInt(cidr);
    return exact !== null && ipInt === exact;
  }

  const [base, prefixRaw] = cidr.split("/");
  const baseInt = ipv4ToInt(base ?? "");
  const prefix = Number(prefixRaw);
  if (baseInt === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return false;
  }

  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;

  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    out = ((out << 8) + n) >>> 0;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the inference proxy on the given port.
 * Resolves when the server is listening; rejects on bind failure.
 */
export function startProxyServer(opts: ProxyServerOptions): Promise<void> {
  if (_server) return Promise.resolve(); // idempotent

  const server = createServer();
  _server = server;
  _startedAt = Date.now();

  // ── HTTP proxy requests (GET/POST/etc. via proxy) ──────────────────────
  server.on(
    "request",
    (req: IncomingMessage, res: ServerResponse) => {
      handleHttpRequest(req, res, opts).catch((err) => {
        log.error(`[proxy] request handler: ${String(err)}`);
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "text/plain" });
          res.end("Bad Gateway");
        }
      });
    },
  );

  // ── HTTPS CONNECT tunnels ─────────────────────────────────────────────
  server.on(
    "connect",
    (req: IncomingMessage, socket: Socket, head: Buffer) => {
      handleConnectTunnel(req, socket, head, opts).catch((err) => {
        log.error(`[proxy] connect handler: ${String(err)}`);
        socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        socket.destroy();
      });
    },
  );

  server.on("error", (err) => {
    log.error(`[proxy] server error: ${String(err)}`);
  });

  return new Promise((resolve, reject) => {
    server.listen(opts.port, "0.0.0.0", () => {
      log.info(`[proxy] listening on :${opts.port}`);
      resolve();
    });
    server.once("error", reject);
  });
}

/**
 * Gracefully shut down the proxy server.
 * Resolves when all connections are closed.
 */
export function stopProxyServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!_server) {
      resolve();
      return;
    }
    _server.close(() => {
      _server = null;
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// HTTP proxy handler
// ---------------------------------------------------------------------------

async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ProxyServerOptions,
): Promise<void> {
  // ── Source IP guard ────────────────────────────────────────────────────
  // Reject connections from untrusted sources (LAN, Wi-Fi, internet).
  // Only loopback and configured Docker network CIDRs are accepted.
  if (!isTrustedSource(req.socket.remoteAddress, opts.trustedSourceCidrs)) {
    log.warn(`[proxy] rejected request from untrusted source: ${req.socket.remoteAddress}`);
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("Forbidden — SILO proxy only accepts local connections.\n");
    return;
  }

  // The proxy receives the full target URL in req.url for HTTP proxy requests
  const rawUrl = req.url ?? "";
  // One parsed target drives routing, the policy check, and the upstream
  // connection — never re-derive the destination from a different source.
  const target = resolveProxyTarget(rawUrl, req.headers["host"]);
  const host = target ? normaliseHostname(target.hostname) : "";
  const startMs = Date.now();

  log.debug(`[proxy] ${req.method} ${rawUrl} (host: ${host})`);

  // ── Health check endpoint ──────────────────────────────────────────────
  if (rawUrl === "/_silo/health" || rawUrl.endsWith("/_silo/health")) {
    const payload = JSON.stringify({
      status: "ok",
      pid: process.pid,
      uptimeMs: Date.now() - _startedAt,
    });
    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    });
    res.end(payload);
    return;
  }

  // ── Trace collection endpoint ─────────────────────────────────────────
  if (
    (rawUrl === "/_silo/traces" || rawUrl.endsWith("/_silo/traces")) &&
    req.method === "POST"
  ) {
    await handleTraceIngestion(req, res);
    return;
  }

  // ── Operator-only prompt endpoints ─────────────────────────────────────
  // Only the host CLI listener may see or answer queued prompts; anything
  // else (notably the sandbox) gets 403 and never marks a listener active.
  const decisionMatch = PROMPT_DECISION_PATH.exec(rawUrl);
  if (rawUrl === "/_silo/prompts" || rawUrl.startsWith("/_silo/prompts/") || decisionMatch) {
    if (
      !isAuthorizedControlRequest(
        req.socket.remoteAddress,
        req.headers[CONTROL_TOKEN_HEADER],
        opts.controlToken,
      )
    ) {
      log.warn(`[proxy] rejected unauthorised prompt-control request from ${req.socket.remoteAddress}`);
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("Forbidden\n");
      return;
    }
  }

  // ── Pending prompts query endpoint ─────────────────────────────────────
  if (rawUrl === "/_silo/prompts" && req.method === "GET") {
    const { getPendingPrompts, registerPromptPoll } = await import("./interceptor.js");
    registerPromptPoll();
    const prompts = getPendingPrompts();
    const payload = JSON.stringify(prompts);
    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    });
    res.end(payload);
    return;
  }

  // ── Submit prompt decision endpoint ────────────────────────────────────
  if (decisionMatch && req.method === "POST") {
    const id = decisionMatch[1]!;
    let decision: unknown;
    try {
      const json = JSON.parse(await readRequestBody(req, 4 * 1024)) as { decision?: unknown };
      decision = json.decision;
    } catch {
      decision = undefined;
    }
    if (typeof decision !== "string" || !PROMPT_DECISIONS.has(decision)) {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("Invalid body");
      return;
    }

    const { submitPromptDecision } = await import("./interceptor.js");
    const success = submitPromptDecision(id, decision as "allow_once" | "allow_always" | "deny");
    const payload = JSON.stringify({ success });
    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    });
    res.end(payload);
    return;
  }

  if (rawUrl === "/_silo/prompts" || rawUrl.startsWith("/_silo/prompts/")) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not Found\n");
    return;
  }

  // ── Local runner compatibility ──────────────────────────────────────────
  // silo run talks to the proxy at 127.0.0.1:{port} using origin-form paths
  // (e.g. "/v1/chat/completions"), not absolute-form proxy targets.
  //
  // Treat those requests as LLM gateway traffic so the proxy can inject creds,
  // audit the call, and forward to the configured provider.
  if (
    rawUrl.startsWith("/") &&
    req.headers["x-silo-runner"] === "silo-run"
  ) {
    await forwardToProvider(req, res, rawUrl, opts, startMs);
    return;
  }

  if (!target) {
    res.writeHead(400, { "content-type": "text/plain" });
    res.end("Bad Request — proxy target must be an http:// or https:// URL.\n");
    void appendAuditEntry({
      method: req.method ?? "GET",
      host: "",
      url: rawUrl,
      category: "blocked",
      verdict: "deny",
      statusCode: 400,
      latencyMs: Date.now() - startMs,
    });
    return;
  }

  if (isLlmGateway(host)) {
    await forwardToProvider(req, res, rawUrl, opts, startMs);
    return;
  }

  // ── Integration gateway (e.g. slack.gateway, hubspot.gateway) ──────────
  const integrations = opts.getIntegrations();
  const integration = findIntegration(host, integrations);
  if (integration) {
    await forwardToIntegration(req, res, rawUrl, integration, startMs);
    return;
  }

  // Host loopback is never reachable through the proxy, regardless of policy
  if (isLoopbackHostname(host)) {
    rejectLoopbackHttp(req, res, host, rawUrl, startMs);
    return;
  }

  // Policy gate for non-LLM destinations
  const compiled = opts.getCompiledPolicy();
  const verdict = evaluateCompiled(compiled, host);

  if (verdict === "deny") {
    const decision = await promptApproveOrDeny({
      method: req.method ?? "GET",
      url: rawUrl,
      host,
      timestamp: new Date(),
    });

    if (decision === "deny") {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end(`Blocked by SILO policy: ${host}`);
      void appendAuditEntry({
        method: req.method ?? "GET",
        host,
        url: rawUrl,
        category: "blocked",
        verdict: "deny",
        statusCode: 403,
        latencyMs: Date.now() - startMs,
      });
      return;
    }
  }

  // Allowed — forward as a plain HTTP proxy hop
  await forwardPlain(req, res, target, rawUrl, startMs);
}

function rejectLoopbackHttp(
  req: IncomingMessage,
  res: ServerResponse,
  host: string,
  rawUrl: string,
  startMs: number,
): void {
  if (!res.headersSent) {
    res.writeHead(403, { "content-type": "text/plain" });
    res.end(`Blocked by SILO: host loopback is not reachable from the sandbox (${host})\n`);
  }
  void appendAuditEntry({
    method: req.method ?? "GET",
    host,
    url: rawUrl,
    category: "blocked",
    verdict: "deny",
    statusCode: 403,
    latencyMs: Date.now() - startMs,
  });
}

// ---------------------------------------------------------------------------
// CONNECT tunnel handler
// ---------------------------------------------------------------------------

async function handleConnectTunnel(
  req: IncomingMessage,
  socket: Socket,
  head: Buffer,
  opts: ProxyServerOptions,
): Promise<void> {
  const target = req.url ?? ""; // format: "host:port"

  // ── Source IP guard (same as HTTP handler) ──────────────────────────────
  if (!isTrustedSource(socket.remoteAddress, opts.trustedSourceCidrs)) {
    log.warn(`[proxy] rejected CONNECT from untrusted source: ${socket.remoteAddress}`);
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }

  const colonIdx = target.lastIndexOf(":");
  const host = normaliseHostname(colonIdx !== -1 ? target.slice(0, colonIdx) : target);
  const port = colonIdx !== -1 ? parseInt(target.slice(colonIdx + 1), 10) : 443;
  const startMs = Date.now();

  log.debug(`[proxy] CONNECT ${target}`);

  // Reject CONNECT to llm.gateway — the agent must use plain HTTP for LLM
  if (isLlmGateway(host)) {
    socket.write(
      "HTTP/1.1 400 Bad Request\r\n" +
        "content-type: text/plain\r\n\r\n" +
        "Use http://llm.gateway (not HTTPS) for LLM API calls.\n",
    );
    socket.destroy();
    void appendAuditEntry({
      method: "CONNECT",
      host,
      url: target,
      category: "blocked",
      verdict: "deny",
      statusCode: 400,
      latencyMs: Date.now() - startMs,
    });
    return;
  }

  // Reject CONNECT to integration gateways — must use plain HTTP
  const integrations = opts.getIntegrations();
  if (isIntegrationGateway(host, integrations)) {
    const integration = findIntegration(host, integrations);
    socket.write(
      "HTTP/1.1 400 Bad Request\r\n" +
        "content-type: text/plain\r\n\r\n" +
        `Use http://${host} (not HTTPS) for ${integration?.name ?? host} API calls.\n`,
    );
    socket.destroy();
    void appendAuditEntry({
      method: "CONNECT",
      host,
      url: target,
      category: "blocked",
      verdict: "deny",
      statusCode: 400,
      latencyMs: Date.now() - startMs,
      service: integration?.name,
    });
    return;
  }

  // Host loopback is never reachable through the proxy, regardless of policy
  if (isLoopbackHostname(host)) {
    rejectLoopbackConnect(socket, host, target, startMs);
    return;
  }

  // Policy gate
  const compiled = opts.getCompiledPolicy();
  const verdict = evaluateCompiled(compiled, host);

  if (verdict === "deny") {
    const decision = await promptApproveOrDeny({
      method: "CONNECT",
      url: target,
      host,
      timestamp: new Date(),
    });

    if (decision === "deny") {
      socket.write(
        "HTTP/1.1 403 Forbidden\r\n" +
          "content-type: text/plain\r\n\r\n" +
          `Blocked by SILO policy: ${host}\n`,
      );
      socket.destroy();
      void appendAuditEntry({
        method: "CONNECT",
        host,
        url: target,
        category: "blocked",
        verdict: "deny",
        statusCode: 403,
        latencyMs: Date.now() - startMs,
      });
      return;
    }
  }

  // Establish TCP tunnel to the target
  // guardedLookup refuses names that resolve to host loopback
  const upstream = createConnection({ host, port, lookup: guardedLookup }, () => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
    void appendAuditEntry({
      method: "CONNECT",
      host,
      url: target,
      category: "egress",
      verdict: "allow",
      statusCode: 200,
      latencyMs: Date.now() - startMs,
    });
  });

  upstream.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === LOOPBACK_BLOCKED_CODE) {
      rejectLoopbackConnect(socket, host, target, startMs);
      return;
    }
    log.debug(`[proxy] CONNECT upstream error for ${target}: ${String(err)}`);
    socket.destroy();
  });

  socket.on("error", () => {
    upstream.destroy();
  });
}

function rejectLoopbackConnect(
  socket: Socket,
  host: string,
  target: string,
  startMs: number,
): void {
  socket.write(
    "HTTP/1.1 403 Forbidden\r\n" +
      "content-type: text/plain\r\n\r\n" +
      `Blocked by SILO: host loopback is not reachable from the sandbox (${host})\n`,
  );
  socket.destroy();
  void appendAuditEntry({
    method: "CONNECT",
    host,
    url: target,
    category: "blocked",
    verdict: "deny",
    statusCode: 403,
    latencyMs: Date.now() - startMs,
  });
}

// ---------------------------------------------------------------------------
// Forward an HTTP request to the LLM provider
// ---------------------------------------------------------------------------

async function forwardToProvider(
  req: IncomingMessage,
  res: ServerResponse,
  rawUrl: string,
  opts: ProxyServerOptions,
  startMs: number,
): Promise<void> {
  const target = resolveProviderTarget(opts.getLlm());

  // Reconstruct the path from the incoming URL
  let path: string;
  try {
    const parsed = new URL(rawUrl.startsWith("http") ? rawUrl : `http://llm.gateway${rawUrl}`);
    path = parsed.pathname + parsed.search;
  } catch {
    path = rawUrl;
  }

  const upstreamUrl = `${target.baseUrl}${path}`;
  const parsed = new URL(upstreamUrl);
  const isHttps = parsed.protocol === "https:";

  // Build outbound headers: start from the incoming headers, strip auth,
  // inject the real credentials, then fix host/connection headers.
  const outHeaders: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    const lower = k.toLowerCase();
    if (
      lower === "host" ||
      lower === "proxy-connection" ||
      lower === "proxy-authorization" ||
      STRIPPED_REQUEST_HEADERS.has(lower)
    ) {
      continue;
    }
    outHeaders[lower] = v;
  }

  // Inject real credentials
  for (const [k, v] of Object.entries(target.authHeaders)) {
    outHeaders[k.toLowerCase()] = v;
  }

  outHeaders["host"] = parsed.host;
  outHeaders["connection"] = "keep-alive";

  log.debug(`[proxy] → ${req.method} ${upstreamUrl}`);

  const makeRequest = isHttps ? makeHttpsRequest : makeHttpRequest;
  const llmRequestId = randomUUID();
  const framework = (req.headers["x-silo-framework"] as string | undefined)
    ?? undefined;

  await new Promise<void>((resolve, reject) => {
    const reqBodyChunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      reqBodyChunks.push(chunk);
    });

    req.on("end", () => {
      let messagesSent: number | undefined;
      const requestBody = Buffer.concat(reqBodyChunks);
      const requestBytes = requestBody.length;
      const bodyStr = requestBody.toString("utf8");
      try {
        const json = JSON.parse(bodyStr);
        if (json && Array.isArray(json.messages)) {
          messagesSent = json.messages.length;
        }
      } catch {
        // ignore
      }

      const messageEntries = extractLlmMessages(bodyStr);
      for (const message of messageEntries) {
        void appendAuditEntry({
          method: "MESSAGE",
          host: "llm.gateway",
          url: rawUrl,
          category: "llm_message",
          verdict: "allow",
          statusCode: 0,
          latencyMs: 0,
          model: opts.getLlm().model,
          framework,
          llmRequestId,
          messageIndex: message.index,
          messageRole: message.role,
          messageContentType: message.contentType,
          messagePreview: message.preview,
          messageChars: message.chars,
          messageName: message.name,
        });
      }

      const upstreamStartMs = Date.now();
      const upstream = makeRequest(
        {
          hostname: parsed.hostname,
          port: parsed.port || (isHttps ? 443 : 80),
          path: parsed.pathname + parsed.search,
          method: req.method,
          headers: outHeaders,
        },
        (upRes) => {
          const responseHeadersMs = Date.now() - upstreamStartMs;
          log.debug(`[proxy] ← ${upRes.statusCode} from ${parsed.hostname}`);

          const responseHeaders: Record<string, string | string[]> = {};
          for (const [k, v] of Object.entries(upRes.headers)) {
            if (v !== undefined && k.toLowerCase() !== "connection") {
              responseHeaders[k] = v;
            }
          }

          res.writeHead(upRes.statusCode ?? 200, responseHeaders);

          // Buffer a copy of the response body for tool call and token extraction.
          // Cap at 2MB to prevent memory exhaustion from oversized responses.
          const MAX_AUDIT_BUFFER = 2 * 1024 * 1024;
          const bodyChunks: Buffer[] = [];
          let auditBodySize = 0;
          let responseBytes = 0;
          let ttfbMs: number | undefined;
          upRes.on("data", (chunk: Buffer) => {
            ttfbMs ??= Date.now() - upstreamStartMs;
            responseBytes += chunk.length;
            res.write(chunk);
            if (auditBodySize < MAX_AUDIT_BUFFER) {
              bodyChunks.push(chunk);
              auditBodySize += chunk.length;
            }
          });

          upRes.on("end", () => {
            res.end();

            // Parse response body for tool call extraction
            const body = Buffer.concat(bodyChunks).toString("utf8");
            const statusCode = upRes.statusCode ?? 200;

            // Extract token usage
            const usage = extractTokenUsage(body, opts.getLlm().provider);

            void appendAuditEntry({
              method: req.method ?? "GET",
              host: "llm.gateway",
              url: rawUrl,
              category: "llm",
              verdict: "allow",
              statusCode,
              latencyMs: Date.now() - startMs,
              ttfbMs: ttfbMs ?? responseHeadersMs,
              requestBytes,
              responseBytes,
              model: opts.getLlm().model,
              framework,
              llmRequestId,
              errorPreview: statusCode >= 400 ? extractErrorPreview(body) : undefined,
              promptTokens: usage.promptTokens,
              completionTokens: usage.completionTokens,
              totalTokens: usage.totalTokens,
              messagesSent,
            });

            // Extract and log individual tool calls
            const toolCalls = extractToolCalls(body, opts.getLlm().provider);
            for (const tc of toolCalls) {
              void appendAuditEntry({
                method: "TOOL_CALL",
                host: "llm.gateway",
                url: rawUrl,
                category: "tool_call",
                verdict: "allow",
                statusCode,
                latencyMs: 0,
                model: opts.getLlm().model,
                llmRequestId,
                toolName: tc.name,
                toolCallId: tc.id,
                toolArgs: tc.arguments.slice(0, 2000), // Truncate large args
                framework,
              });
            }

            resolve();
          });
          upRes.on("error", reject);
        },
      );

      upstream.on("error", (err) => {
        log.error(`[proxy] upstream error: ${String(err)}`);
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "text/plain" });
          res.end("Bad Gateway — upstream LLM provider unreachable.");
        }
        reject(err);
      });

      // Write buffered request body to upstream
      upstream.write(requestBody);
      upstream.end();
    });

    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Forward a plain HTTP proxy request (non-LLM, policy-allowed)
// ---------------------------------------------------------------------------

async function forwardPlain(
  req: IncomingMessage,
  res: ServerResponse,
  parsed: URL,
  rawUrl: string,
  startMs: number,
): Promise<void> {
  const isHttps = parsed.protocol === "https:";
  const hostname = normaliseHostname(parsed.hostname);

  const outHeaders: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    const lower = k.toLowerCase();
    if (lower === "proxy-connection" || lower === "proxy-authorization") continue;
    outHeaders[lower] = v;
  }
  outHeaders["connection"] = "keep-alive";
  // Send the Host we policy-checked, not whatever the client claimed
  outHeaders["host"] = parsed.host;

  const makeRequest = isHttps ? makeHttpsRequest : makeHttpRequest;

  await new Promise<void>((resolve, reject) => {
    const upstream = makeRequest(
      {
        hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: req.method,
        headers: outHeaders,
        // Refuse names that resolve to host loopback
        lookup: guardedLookup,
      },
      (upRes) => {
        const responseHeaders: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(upRes.headers)) {
          if (v !== undefined && k.toLowerCase() !== "connection") {
            responseHeaders[k] = v;
          }
        }
        res.writeHead(upRes.statusCode ?? 200, responseHeaders);
        upRes.pipe(res);
        upRes.on("end", () => {
          void appendAuditEntry({
            method: req.method ?? "GET",
            host: hostname,
            url: rawUrl,
            category: "egress",
            verdict: "allow",
            statusCode: upRes.statusCode ?? 200,
            latencyMs: Date.now() - startMs,
          });
          resolve();
        });
        upRes.on("error", reject);
      },
    );

    upstream.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === LOOPBACK_BLOCKED_CODE) {
        rejectLoopbackHttp(req, res, hostname, rawUrl, startMs);
        resolve();
        return;
      }
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end("Bad Gateway");
      }
      reject(err);
    });

    req.pipe(upstream);
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return true for all llm.gateway variants (with or without port). */
function isLlmGateway(host: string): boolean {
  return /^llm\.gateway(:\d+)?$/.test(host);
}

// ---------------------------------------------------------------------------
// Forward an HTTP request to an integration API
// ---------------------------------------------------------------------------

async function forwardToIntegration(
  req: IncomingMessage,
  res: ServerResponse,
  rawUrl: string,
  integration: IntegrationConfig,
  startMs: number,
): Promise<void> {
  const target = resolveIntegrationTarget(integration);

  // Reconstruct the path from the incoming URL
  let path: string;
  try {
    const parsed = new URL(
      rawUrl.startsWith("http") ? rawUrl : `http://${integration.gateway}${rawUrl}`,
    );
    path = parsed.pathname + parsed.search;
  } catch {
    path = rawUrl;
  }

  // Append query-param auth if configured
  if (Object.keys(target.queryParams).length > 0) {
    const separator = path.includes("?") ? "&" : "?";
    const params = new URLSearchParams(target.queryParams).toString();
    path = `${path}${separator}${params}`;
  }

  const upstreamUrl = `${target.baseUrl}${path}`;
  const parsed = new URL(upstreamUrl);
  const isHttps = parsed.protocol === "https:";

  // Build outbound headers: start from incoming, strip auth, inject real creds
  const outHeaders: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    const lower = k.toLowerCase();
    if (
      lower === "host" ||
      lower === "proxy-connection" ||
      lower === "proxy-authorization" ||
      STRIPPED_REQUEST_HEADERS.has(lower)
    ) {
      continue;
    }
    outHeaders[lower] = v;
  }

  // Inject real credentials
  for (const [k, v] of Object.entries(target.authHeaders)) {
    outHeaders[k.toLowerCase()] = v;
  }

  outHeaders["host"] = parsed.host;
  outHeaders["connection"] = "close";

  log.debug(`[proxy] → integration:${integration.name} ${req.method} ${upstreamUrl}`);

  const makeRequest = isHttps ? makeHttpsRequest : makeHttpRequest;

  await new Promise<void>((resolve, reject) => {
    const upstream = makeRequest(
      {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: req.method,
        headers: outHeaders,
      },
      (upRes) => {
        log.debug(
          `[proxy] ← ${upRes.statusCode} from ${integration.name} (${parsed.hostname})`,
        );

        const responseHeaders: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(upRes.headers)) {
          if (v !== undefined && k.toLowerCase() !== "connection") {
            responseHeaders[k] = v;
          }
        }

        res.writeHead(upRes.statusCode ?? 200, responseHeaders);
        upRes.pipe(res);

        upRes.on("end", () => {
          void appendAuditEntry({
            method: req.method ?? "GET",
            host: integration.gateway,
            url: rawUrl,
            category: "integration",
            verdict: "allow",
            statusCode: upRes.statusCode ?? 200,
            latencyMs: Date.now() - startMs,
            service: integration.name,
          });
          resolve();
        });
        upRes.on("error", reject);
      },
    );

    upstream.on("error", (err) => {
      log.error(
        `[proxy] integration upstream error (${integration.name}): ${String(err)}`,
      );
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end(`Bad Gateway — ${integration.name} API unreachable.`);
      }
      reject(err);
    });

    req.pipe(upstream);
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Trace ingestion handler
// ---------------------------------------------------------------------------

/**
 * Handle `POST /_silo/traces` requests from frameworks inside the container.
 * Accepts a single trace or an array of traces.
 */
async function handleTraceIngestion(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const body = await readRequestBody(req, 64 * 1024); // 64KB limit
    let parsed: unknown;

    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    // Accept single trace or array
    const traces: IncomingTrace[] = Array.isArray(parsed)
      ? (parsed as IncomingTrace[])
      : [parsed as IncomingTrace];

    const results = [];
    const errors = [];

    for (const trace of traces) {
      try {
        const entry = await processTrace(trace);
        results.push({ traceId: entry.traceId, event: entry.event });
        log.debug(
          `[traces] ${trace.framework}/${trace.event}` +
            (trace.tool ? ` tool=${trace.tool}` : "") +
            (trace.agent ? ` agent=${trace.agent}` : ""),
        );
      } catch (err) {
        errors.push({
          event: trace.event ?? "unknown",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const status = errors.length > 0 ? 207 : 200; // 207 Multi-Status
    const payload = JSON.stringify({
      accepted: results.length,
      rejected: errors.length,
      traces: results,
      ...(errors.length > 0 ? { errors } : {}),
    });

    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    });
    res.end(payload);
  } catch (err) {
    log.error(`[traces] ingestion error: ${String(err)}`);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Internal trace processing error" }));
    }
  }
}

/**
 * Read the full request body up to a max size.
 */
function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;

    req.on("data", (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > maxBytes) {
        req.destroy();
        reject(new Error(`Request body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    req.on("error", reject);
  });
}
