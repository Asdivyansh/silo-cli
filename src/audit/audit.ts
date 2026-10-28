/**
 * Audit Logger
 *
 * Persistent, append-only JSONL audit trail that records every request
 * flowing through the SILO inference proxy. Each entry captures the
 * request metadata, policy verdict, timing, and optional token usage.
 *
 * Storage: ~/.silo/audit.jsonl
 *
 * Entries can be queried by date range, category, host, or verdict using
 * `readAuditLog()`. The `silo logs` CLI command is built on top of this
 * module.
 */
import { appendFile, readFile, mkdir } from "node:fs/promises";
import { existsSync, statSync, renameSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuditCategory = "llm" | "llm_message" | "egress" | "blocked" | "integration" | "tool_call" | "trace";

export interface AuditEntry {
  /** ISO-8601 timestamp */
  timestamp: string;
  /** Proxy session identifier (generated per daemon start) */
  sessionId: string;
  /** HTTP method (or "TRACE" for framework events) */
  method: string;
  /** Target hostname (or "framework" for trace events) */
  host: string;
  /** Full URL or host:port for CONNECT tunnels */
  url: string;
  /** Request classification */
  category: AuditCategory;
  /** Policy verdict */
  verdict: "allow" | "deny";
  /** Upstream HTTP status code (0 if the request was blocked before forwarding) */
  statusCode: number;
  /** Round-trip latency in milliseconds */
  latencyMs: number;
  /** LLM model used (only for category=llm) */
  model?: string;
  /** Correlation ID shared by one LLM request and its per-message entries */
  llmRequestId?: string;
  /** Time to first response byte/header for LLM calls */
  ttfbMs?: number;
  /** Upstream response body bytes observed by the proxy */
  responseBytes?: number;
  /** Request body bytes observed by the proxy */
  requestBytes?: number;
  /** Redacted error preview for non-2xx upstream responses */
  errorPreview?: string;
  /** Message index in the LLM request (only for category=llm_message) */
  messageIndex?: number;
  /** Message role in the LLM request (system/user/assistant/tool/etc.) */
  messageRole?: string;
  /** Message content kind (text/parts/object/empty) */
  messageContentType?: string;
  /** Redacted message content preview */
  messagePreview?: string;
  /** Original message content character count before truncation */
  messageChars?: number;
  /** Optional provider message name */
  messageName?: string;
  /** Integration service name (only for category=integration, e.g. "slack") */
  service?: string;
  /** Tool/function name (for category=tool_call or trace tool events) */
  toolName?: string;
  /** Provider tool call ID (for category=tool_call) */
  toolCallId?: string;
  /** Stringified tool arguments (for category=tool_call) */
  toolArgs?: string;
  /** Active framework when this entry was logged */
  framework?: string;
  /** Agent or node name (for category=trace) */
  agent?: string;
  /** Trace event type (for category=trace, e.g. "agent_start", "node_enter") */
  traceEvent?: string;
  /** Trace result snippet (for category=trace) */
  traceResult?: string;
  /** Prompt tokens used (only for category=llm) */
  promptTokens?: number;
  /** Completion tokens used (only for category=llm) */
  completionTokens?: number;
  /** Total tokens used (only for category=llm) */
  totalTokens?: number;
  /** Total messages sent in conversation history (only for category=llm) */
  messagesSent?: number;
}

export interface AuditReadOptions {
  /** Return only the last N entries */
  tail?: number;
  /** Filter by category */
  category?: AuditCategory;
  /** Filter by verdict */
  verdict?: "allow" | "deny";
  /** Only entries after this date */
  since?: Date;
  /** Only entries matching this session ID */
  sessionId?: string;
  /** Filter by framework name */
  framework?: string;
  /** Filter by agent name */
  agent?: string;
  /** Case-insensitive text search */
  query?: string;
  /** Status code range or value */
  status?: string;
  /** Latency range filter */
  latency?: string;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let _sessionId: string = randomUUID();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Start a new audit session. Returns the generated session ID. */
export function startAuditSession(): string {
  _sessionId = randomUUID();
  return _sessionId;
}

/** Get the current audit session ID. */
export function getSessionId(): string {
  return _sessionId;
}

/** Absolute path to the audit log file. */
export function auditLogPath(): string {
  return join(homedir(), ".silo", "audit.jsonl");
}

/**
 * Append a single audit entry to the log file.
 * Creates the directory and file if they do not exist.
 * Rotates the log file if it exceeds SILO_LOG_MAX_BYTES (default 10MB).
 * This is non-blocking and failures are silently ignored to avoid
 * disrupting proxy traffic.
 */
export async function appendAuditEntry(
  entry: Omit<AuditEntry, "timestamp" | "sessionId">,
): Promise<void> {
  try {
    const logPath = auditLogPath();
    const dir = dirname(logPath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    // Rotate before writing if the file is too large (check at most once per minute
    // to avoid synchronous I/O on every audit write in the proxy hot path)
    maybeRotate(logPath);

    const full: AuditEntry = {
      timestamp: new Date().toISOString(),
      sessionId: _sessionId,
      ...entry,
    };

    await appendFile(logPath, JSON.stringify(full) + "\n", "utf8");
  } catch {
    // Non-fatal — audit failures must never block the proxy
  }
}

// ---------------------------------------------------------------------------
// Log rotation
// ---------------------------------------------------------------------------

/** Default max size: 10 MB */
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

/** Maximum number of rotated files to keep */
const MAX_ROTATED_FILES = 5;

/** Minimum interval between rotation checks (ms) */
const ROTATE_CHECK_INTERVAL_MS = 60_000;
let _lastRotateCheckMs = 0;

/** Rate-limited wrapper — only runs the sync stat check once per minute. */
function maybeRotate(logPath: string): void {
  const now = Date.now();
  if (now - _lastRotateCheckMs < ROTATE_CHECK_INTERVAL_MS) return;
  _lastRotateCheckMs = now;
  rotateIfNeeded(logPath);
}

/**
 * Rotate the audit log if it exceeds the max size.
 *
 * Rotation scheme:
 *   audit.jsonl → audit.1.jsonl → audit.2.jsonl → ... → audit.5.jsonl
 *
 * The oldest file (audit.5.jsonl) is deleted when a new rotation occurs.
 * Configurable via the `SILO_LOG_MAX_BYTES` environment variable.
 */
export function rotateIfNeeded(logPath: string): void {
  if (!existsSync(logPath)) return;

  const maxBytes = parseInt(process.env.SILO_LOG_MAX_BYTES ?? "", 10) || DEFAULT_MAX_BYTES;

  let size: number;
  try {
    size = statSync(logPath).size;
  } catch {
    return;
  }

  if (size < maxBytes) return;

  // Rotate files: audit.5 → delete, audit.4 → audit.5, ... , audit → audit.1
  const baseName = logPath.replace(/\.jsonl$/, "");

  for (let i = MAX_ROTATED_FILES; i >= 1; i--) {
    const from = i === 1 ? logPath : `${baseName}.${i - 1}.jsonl`;
    const to = `${baseName}.${i}.jsonl`;

    if (!existsSync(from)) continue;

    if (i === MAX_ROTATED_FILES && existsSync(to)) {
      try { unlinkSync(to); } catch { /* ignore */ }
    }

    try { renameSync(from, to); } catch { /* ignore */ }
  }
}

/**
 * Read audit entries from the log file, optionally filtered.
 * Returns an empty array if the log file does not exist.
 *
 * Optimised for the common `silo logs --tail N` case: when only `tail`
 * is specified, we read from the end of the file instead of parsing
 * everything. For filtered queries, we apply all predicates in a
 * single pass to avoid repeated array allocations.
 */
export async function readAuditLog(
  opts?: AuditReadOptions,
): Promise<AuditEntry[]> {
  const logPath = auditLogPath();
  if (!existsSync(logPath)) return [];

  let raw: string;
  try {
    raw = await readFile(logPath, "utf8");
  } catch {
    return [];
  }

  const lines = raw.trim().split("\n").filter(Boolean);

  // Fast path: tail-only with no filters — parse from end
  const hasFilters =
    opts?.category !== undefined ||
    opts?.verdict !== undefined ||
    opts?.sessionId !== undefined ||
    opts?.since !== undefined ||
    opts?.framework !== undefined ||
    opts?.agent !== undefined ||
    opts?.query !== undefined ||
    opts?.status !== undefined ||
    opts?.latency !== undefined;

  if (!hasFilters && opts?.tail !== undefined && opts.tail > 0) {
    const tailLines = lines.slice(-opts.tail);
    const entries: AuditEntry[] = [];
    for (const line of tailLines) {
      try {
        entries.push(JSON.parse(line) as AuditEntry);
      } catch {
        // Skip malformed lines
      }
    }
    return entries;
  }

  // Build predicate list for single-pass filtering
  const predicates: Array<(e: AuditEntry) => boolean> = [];
  if (opts?.category) {
    const cat = opts.category;
    predicates.push((e) => e.category === cat);
  }
  if (opts?.verdict) {
    const v = opts.verdict;
    predicates.push((e) => e.verdict === v);
  }
  if (opts?.sessionId) {
    const sid = opts.sessionId;
    predicates.push((e) => e.sessionId === sid);
  }
  if (opts?.since) {
    const sinceMs = opts.since.getTime();
    predicates.push((e) => new Date(e.timestamp).getTime() >= sinceMs);
  }
  if (opts?.framework) {
    const fw = opts.framework;
    predicates.push((e) => e.framework === fw);
  }
  if (opts?.agent) {
    const ag = opts.agent;
    predicates.push((e) => e.agent === ag);
  }
  if (opts?.query) {
    const q = opts.query;
    predicates.push((e) => matchQuery(e, q));
  }
  if (opts?.status) {
    const st = opts.status;
    predicates.push((e) => matchStatusCode(e.statusCode, st));
  }
  if (opts?.latency) {
    const lat = opts.latency;
    predicates.push((e) => matchLatency(e.latencyMs, lat));
  }

  // Single pass: parse + filter
  const entries: AuditEntry[] = [];
  for (const line of lines) {
    let entry: AuditEntry;
    try {
      entry = JSON.parse(line) as AuditEntry;
    } catch {
      continue;
    }

    if (predicates.length > 0 && !predicates.every((p) => p(entry))) continue;
    entries.push(entry);
  }

  // Tail
  if (opts?.tail !== undefined && opts.tail > 0) {
    return entries.slice(-opts.tail);
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Advanced filter matchers
// ---------------------------------------------------------------------------

export function matchQuery(e: AuditEntry, query: string): boolean {
  const q = query.toLowerCase().trim();
  if (!q) return true;
  return (
    (e.host?.toLowerCase().includes(q) ?? false) ||
    (e.url?.toLowerCase().includes(q) ?? false) ||
    (e.method?.toLowerCase().includes(q) ?? false) ||
    (e.model?.toLowerCase().includes(q) ?? false) ||
    (e.llmRequestId?.toLowerCase().includes(q) ?? false) ||
    (e.errorPreview?.toLowerCase().includes(q) ?? false) ||
    (e.messageRole?.toLowerCase().includes(q) ?? false) ||
    (e.messagePreview?.toLowerCase().includes(q) ?? false) ||
    (e.messageName?.toLowerCase().includes(q) ?? false) ||
    (e.service?.toLowerCase().includes(q) ?? false) ||
    (e.toolName?.toLowerCase().includes(q) ?? false) ||
    (e.toolArgs?.toLowerCase().includes(q) ?? false) ||
    (e.agent?.toLowerCase().includes(q) ?? false) ||
    (e.traceEvent?.toLowerCase().includes(q) ?? false) ||
    (e.traceResult?.toLowerCase().includes(q) ?? false) ||
    (e.framework?.toLowerCase().includes(q) ?? false)
  );
}

export function matchStatusCode(code: number, filter: string): boolean {
  const f = filter.trim().toLowerCase();
  if (f.endsWith("xx")) {
    const prefix = parseInt(f.slice(0, -2), 10);
    if (isNaN(prefix)) return false;
    const min = prefix * 100;
    const max = min + 99;
    return code >= min && code <= max;
  }
  if (f.includes("-")) {
    const parts = f.split("-").map((p) => parseInt(p.trim(), 10));
    if (parts.length === 2 && !isNaN(parts[0]!) && !isNaN(parts[1]!)) {
      return code >= parts[0]! && code <= parts[1]!;
    }
  }
  const parsed = parseInt(f, 10);
  return !isNaN(parsed) && code === parsed;
}

export function matchLatency(latency: number, filter: string): boolean {
  const f = filter.trim();
  if (f.endsWith("+")) {
    const min = parseInt(f.slice(0, -1).trim(), 10);
    return !isNaN(min) && latency >= min;
  }
  if (f.startsWith(">")) {
    const min = parseInt(f.slice(1).trim(), 10);
    return !isNaN(min) && latency > min;
  }
  if (f.startsWith("<")) {
    const max = parseInt(f.slice(1).trim(), 10);
    return !isNaN(max) && latency < max;
  }
  if (f.includes("-")) {
    const parts = f.split("-").map((p) => parseInt(p.trim(), 10));
    if (parts.length === 2 && !isNaN(parts[0]!) && !isNaN(parts[1]!)) {
      return latency >= parts[0]! && latency <= parts[1]!;
    }
  }
  const parsed = parseInt(f, 10);
  return !isNaN(parsed) && latency === parsed;
}

/**
 * Record a session lifecycle event (start/stop) to the audit log.
 */
export async function logSessionEvent(
  event: "session_start" | "session_stop",
): Promise<void> {
  await appendAuditEntry({
    method: "INTERNAL",
    host: "silo",
    url: event,
    category: "egress",
    verdict: "allow",
    statusCode: 0,
    latencyMs: 0,
  });
}
