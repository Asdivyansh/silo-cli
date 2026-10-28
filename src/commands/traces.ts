/**
 * `silo traces` — Convenience alias for `silo logs --category trace`.
 *
 * Shows framework-level trace events from the unified audit log.
 * All data lives in the same audit.jsonl — this command just
 * pre-filters to trace and tool_call categories.
 *
 * Usage:
 *   silo traces                        — show last 30 trace events
 *   silo traces --framework crewai     — filter by framework
 *   silo traces --event tool_call      — only tool calls
 *   silo traces --agent Researcher     — only from a specific agent
 *   silo traces --json                 — raw JSONL for piping
 */
import { readAuditLog, auditLogPath } from "../audit/audit.js";
import chalk from "chalk";
import Table from "cli-table3";
import { log, section } from "../utils/logger.js";

export interface TracesOptions {
  tail: number;
  framework?: string;
  event?: string;
  agent?: string;
  since?: string;
  json: boolean;
}

export async function runTraces(opts: TracesOptions): Promise<void> {
  // Read both trace and tool_call categories from the unified log
  const allEntries = await readAuditLog({
    tail: opts.tail * 3, // over-fetch since we filter further
    since: opts.since ? parseSince(opts.since) : undefined,
    framework: opts.framework,
    agent: opts.agent,
  });

  // Filter to trace + tool_call categories only
  let entries = allEntries.filter(
    (e) => e.category === "trace" || e.category === "tool_call",
  );

  // Further filter by trace event type if specified
  if (opts.event) {
    entries = entries.filter(
      (e) => e.traceEvent === opts.event || (opts.event === "tool_call" && e.category === "tool_call"),
    );
  }

  // Apply tail
  if (opts.tail > 0) {
    entries = entries.slice(-opts.tail);
  }

  if (entries.length === 0) {
    log.info("No trace entries found.");
    log.info(`Log file: ${chalk.dim(auditLogPath())}`);
    log.blank();
    log.info(
      chalk.dim(
        "Traces are collected when frameworks push events to the SILO proxy.\n" +
          "  Use framework callbacks to emit traces:\n" +
          "    from silo_callbacks import SiloCrewCallbacks\n" +
          "    crew = Crew(..., callbacks=[SiloCrewCallbacks()])",
      ),
    );
    return;
  }

  // Raw JSON mode
  if (opts.json) {
    for (const entry of entries) {
      console.log(JSON.stringify(entry));
    }
    return;
  }

  // Formatted table
  section(`Framework Traces (${entries.length} events)`);
  log.blank();

  const table = new Table({
    head: [
      chalk.bold("Time"),
      chalk.bold("Framework"),
      chalk.bold("Event"),
      chalk.bold("Agent"),
      chalk.bold("Tool"),
      chalk.bold("Duration"),
      chalk.bold("Result"),
    ],
    style: { head: ["cyan"], border: [] },
    colWidths: [12, 12, 14, 16, 18, 10, 24],
    wordWrap: true,
  });

  for (const entry of entries) {
    const time = formatTime(entry.timestamp);
    const fw = chalk.cyan(entry.framework ?? "—");
    const event = entry.traceEvent
      ? formatEvent(entry.traceEvent)
      : entry.category === "tool_call"
        ? chalk.yellow("tool_call")
        : chalk.dim("—");
    const agent = entry.agent
      ? chalk.white(truncate(entry.agent, 14))
      : chalk.dim("—");
    const tool = entry.toolName
      ? chalk.yellow(`⚡ ${truncate(entry.toolName, 14)}`)
      : chalk.dim("—");
    const duration = entry.latencyMs
      ? `${entry.latencyMs}ms`
      : chalk.dim("—");
    const result = entry.traceResult
      ? chalk.dim(truncate(entry.traceResult, 22))
      : chalk.dim("—");

    table.push([time, fw, event, agent, tool, duration, result]);
  }

  console.log(table.toString());
  log.blank();
  log.info(`Log file: ${chalk.dim(auditLogPath())} ${chalk.dim("(unified)")}`);
  log.blank();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString("en-GB", { hour12: false });
  } catch {
    return iso.slice(11, 19);
  }
}

function formatEvent(event: string): string {
  const colors: Record<string, (s: string) => string> = {
    tool_call: chalk.yellow,
    agent_start: chalk.green,
    agent_end: chalk.green,
    task_start: chalk.blue,
    task_end: chalk.blue,
    delegation: chalk.magenta,
    node_enter: chalk.cyan,
    node_exit: chalk.cyan,
    step: chalk.white,
    error: chalk.red,
    custom: chalk.gray,
  };
  const colorFn = colors[event] ?? chalk.white;
  return colorFn(event);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function parseSince(duration: string): Date {
  const match = /^(\d+)\s*(s|m|h|d|w)$/.exec(duration.trim());
  if (!match) {
    throw new Error(
      `Invalid duration "${duration}". Use formats like: 30m, 2h, 1d`,
    );
  }
  const value = parseInt(match[1]!, 10);
  const unit = match[2]!;
  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };
  return new Date(Date.now() - value * multipliers[unit]!);
}
