/**
 * Framework Trace Collector
 *
 * Provides a REST endpoint (`POST /_silo/traces`) on the proxy that
 * agent frameworks running inside the container can push trace events to.
 *
 * All traces are written directly into the unified audit log
 * (`~/.silo/audit.jsonl`) as `category: "trace"` entries, so they
 * appear alongside LLM calls, egress, and tool calls in `silo logs`.
 *
 * Trace format (JSON POST body):
 * ```json
 * {
 *   "framework": "crewai",
 *   "event": "tool_call" | "agent_start" | "agent_end" | "task_start" |
 *            "task_end" | "delegation" | "node_enter" | "node_exit" |
 *            "step" | "error",
 *   "agent": "Researcher",          // optional — agent/node name
 *   "tool": "search_web",           // optional — tool name
 *   "args": { "query": "..." },     // optional — tool arguments
 *   "result": "...",                 // optional — truncated result
 *   "parent": "task-123",           // optional — parent span/task ID
 *   "meta": { ... }                 // optional — arbitrary metadata
 * }
 * ```
 */
import { randomUUID } from "node:crypto";
import { appendAuditEntry } from "./audit.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TraceEvent =
  | "tool_call"
  | "agent_start"
  | "agent_end"
  | "task_start"
  | "task_end"
  | "delegation"
  | "node_enter"
  | "node_exit"
  | "step"
  | "error"
  | "custom";

export interface IncomingTrace {
  framework: string;
  event: string;
  agent?: string;
  tool?: string;
  args?: Record<string, unknown>;
  result?: string;
  parent?: string;
  durationMs?: number;
  meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_EVENTS = new Set<string>([
  "tool_call", "agent_start", "agent_end",
  "task_start", "task_end", "delegation",
  "node_enter", "node_exit", "step", "error", "custom",
]);

const MAX_RESULT_LENGTH = 2000;
const MAX_ARGS_KEYS = 20;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Process an incoming trace from a framework.
 * Validates, enriches, and writes directly into the unified audit log.
 *
 * @returns The generated trace ID
 * @throws Error if the trace is invalid
 */
export async function processTrace(incoming: IncomingTrace): Promise<{ traceId: string; event: string }> {
  // Validate required fields
  if (!incoming.framework || typeof incoming.framework !== "string") {
    throw new Error("Missing required field: framework");
  }
  if (!incoming.event || !VALID_EVENTS.has(incoming.event)) {
    throw new Error(
      `Invalid event type: "${incoming.event}". Valid: ${[...VALID_EVENTS].join(", ")}`,
    );
  }

  const traceId = randomUUID();
  const event = incoming.event as TraceEvent;

  // Determine category — framework tool_call events go as "tool_call",
  // everything else goes as "trace"
  const category = event === "tool_call" ? "tool_call" as const : "trace" as const;

  // Build the unified audit entry
  await appendAuditEntry({
    method: "TRACE",
    host: "framework",
    url: `${incoming.framework}/${incoming.agent ?? "agent"}/${event}`,
    category,
    verdict: "allow",
    statusCode: 0,
    latencyMs: incoming.durationMs ?? 0,
    framework: incoming.framework,
    agent: incoming.agent ? String(incoming.agent).slice(0, 200) : undefined,
    traceEvent: event,
    // Tool-specific fields
    ...(incoming.tool ? { toolName: String(incoming.tool).slice(0, 200) } : {}),
    ...(incoming.tool ? { toolCallId: traceId } : {}),
    ...(incoming.args
      ? { toolArgs: JSON.stringify(sanitiseArgs(incoming.args)).slice(0, 2000) }
      : {}),
    // Trace result
    ...(incoming.result
      ? { traceResult: String(incoming.result).slice(0, MAX_RESULT_LENGTH) }
      : {}),
  });

  return { traceId, event };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sanitiseArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const sanitised: Record<string, unknown> = {};
  let count = 0;
  for (const [k, v] of Object.entries(args)) {
    if (count >= MAX_ARGS_KEYS) break;
    if (typeof v === "string" && v.length > MAX_RESULT_LENGTH) {
      sanitised[k] = v.slice(0, MAX_RESULT_LENGTH) + "…";
    } else {
      sanitised[k] = v;
    }
    count++;
  }
  return sanitised;
}
