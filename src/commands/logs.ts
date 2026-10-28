/**
 * `silo logs` — View the proxy audit trail.
 *
 * Displays formatted audit log entries showing every request that flowed
 * through the inference proxy, including LLM calls, allowed egress, and
 * blocked requests.
 *
 * Usage:
 *   silo logs                     — show last 20 entries
 *   silo logs --tail 50           — show last 50 entries
 *   silo logs --category llm      — filter by category
 *   silo logs --since 1h          — entries from the last hour
 *   silo logs --verdict deny      — only blocked requests
 *   silo logs --json              — raw JSONL for piping
 */
import chalk from "chalk";
import Table from "cli-table3";
import { watch, statSync } from "node:fs";
import {
  readAuditLog,
  auditLogPath,
  matchQuery,
  matchStatusCode,
  matchLatency,
  type AuditCategory,
  type AuditEntry,
} from "../audit/audit.js";
import { log, section } from "../utils/logger.js";

export interface LogsOptions {
  tail: number;
  category?: string;
  verdict?: string;
  since?: string;
  framework?: string;
  agent?: string;
  query?: string;
  status?: string;
  latency?: string;
  json: boolean;
  follow: boolean;
  interactive: boolean;
}

export function printLogsTable(entries: AuditEntry[]): void {
  const visibleEntries = entries.filter((e) => e.method !== "INTERNAL");
  section(`Audit Log (${visibleEntries.length} entries)`);
  log.blank();

  const table = new Table({
    head: [
      chalk.bold("Time"),
      chalk.bold("Category"),
      chalk.bold("Verdict"),
      chalk.bold("Method"),
      chalk.bold("Host / Tool"),
      chalk.bold("Status"),
      chalk.bold("Latency"),
      chalk.bold("Details"),
    ],
    style: { head: ["cyan"], border: [] },
    colWidths: [12, 12, 8, 10, 28, 8, 9, 26],
    wordWrap: true,
  });

  for (const entry of entries) {
    // Skip internal session events in table view
    if (entry.method === "INTERNAL") continue;

    const time = formatTime(entry.timestamp);
    const cat = formatCategory(entry.category);
    const verdict = entry.verdict === "allow"
      ? chalk.green("allow")
      : chalk.red("deny");

    const statusVal = entry.statusCode > 0
      ? String(entry.statusCode)
      : chalk.dim("—");
    const statusColor = entry.statusCode >= 200 && entry.statusCode < 300
      ? chalk.green
      : entry.statusCode >= 300 && entry.statusCode < 400
        ? chalk.yellow
        : chalk.red;
    const status = entry.statusCode > 0 ? statusColor(statusVal) : statusVal;

    const latency = formatLatency(entry);

    // Tool call entries show tool name and args
    if (entry.category === "tool_call") {
      const toolDisplay = entry.toolName
        ? chalk.yellow(`⚡ ${entry.toolName}`)
        : chalk.dim("—");
      const argsPreview = entry.toolArgs
        ? chalk.dim(truncate(entry.toolArgs, 16))
        : chalk.dim("—");

      table.push([
        time,
        cat,
        verdict,
        chalk.dim("TOOL"),
        toolDisplay,
        status,
        latency,
        argsPreview,
      ]);
    } else if (entry.category === "llm_message") {
      const index = entry.messageIndex === -1 ? "sys" : String(entry.messageIndex ?? "—");
      const role = entry.messageRole ?? "message";
      const label = chalk.cyan(`${index}:${role}`);
      const preview = entry.messagePreview
        ? truncate(entry.messagePreview, 24)
        : chalk.dim("—");

      table.push([
        time,
        cat,
        verdict,
        chalk.dim("MSG"),
        label,
        chalk.dim("—"),
        chalk.dim("—"),
        chalk.dim(preview),
      ]);
    } else if (entry.category === "trace") {
      // Framework trace events — show agent and event type
      const agentDisplay = entry.agent
        ? chalk.white(truncate(entry.agent, 14))
        : chalk.dim("—");
      const eventLabel = entry.traceEvent
        ? chalk.magenta(entry.traceEvent)
        : chalk.dim("trace");
      const detail = entry.traceResult
        ? chalk.dim(truncate(entry.traceResult, 16))
        : entry.framework
          ? chalk.dim(entry.framework)
          : chalk.dim("—");

      table.push([
        time,
        eventLabel,
        verdict,
        chalk.dim("TRACE"),
        agentDisplay,
        status,
        latency,
        detail,
      ]);
    } else {
      // Standard entry (llm, egress, blocked, integration)
      let details = "";
      if (entry.category === "llm") {
        const parts: string[] = [];
        if (entry.messagesSent !== undefined) {
          parts.push(`msgs: ${entry.messagesSent}`);
        }
        if (entry.ttfbMs !== undefined) {
          parts.push(`ttfb: ${entry.ttfbMs}ms`);
        }
        if (entry.totalTokens !== undefined) {
          parts.push(`tokens: ${entry.totalTokens}`);
        } else if (entry.promptTokens !== undefined || entry.completionTokens !== undefined) {
          parts.push(`P:${entry.promptTokens ?? "—"}/C:${entry.completionTokens ?? "—"}`);
        }
        if (entry.errorPreview) {
          parts.push(`err: ${truncate(entry.errorPreview, 18)}`);
        }
        if (entry.framework) {
          parts.push(entry.framework);
        }
        details = parts.length > 0 ? parts.join(" | ") : "—";
      } else {
        details = entry.framework ? entry.framework : "—";
      }

      table.push([
        time,
        cat,
        verdict,
        entry.method,
        truncate(entry.host, 26),
        status,
        latency,
        chalk.dim(details),
      ]);
    }
  }

  console.log(table.toString());
}

export async function runLogs(opts: LogsOptions): Promise<void> {
  const queryOptions = {
    tail: opts.tail,
    category: opts.category as AuditCategory | undefined,
    verdict: opts.verdict as "allow" | "deny" | undefined,
    since: opts.since ? parseSince(opts.since) : undefined,
    framework: opts.framework,
    agent: opts.agent,
    query: opts.query,
    status: opts.status,
    latency: opts.latency,
  };

  const entries = await readAuditLog(queryOptions);

  // Interactive mode
  if (opts.interactive) {
    const { launchInteractiveTui } = await import("./tui.js");
    await launchInteractiveTui(entries, () => readAuditLog(queryOptions));
    return;
  }

  if (entries.length === 0) {
    log.info("No audit log entries found.");
    log.info(`Log file: ${chalk.dim(auditLogPath())}`);
    return;
  }

  // Raw JSON mode
  if (opts.json) {
    for (const entry of entries) {
      console.log(JSON.stringify(entry));
    }
    return;
  }

  // Formatted table mode
  printLogsTable(entries);
  log.blank();
  log.info(`Log file: ${chalk.dim(auditLogPath())}`);
  log.blank();

  // Follow mode — watch for new entries
  if (opts.follow) {
    await followAuditLog(opts, entries);
  }
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

function formatCategory(cat: AuditCategory): string {
  switch (cat) {
    case "llm":         return chalk.cyan("llm");
    case "llm_message": return chalk.cyan("msg");
    case "egress":      return chalk.blue("egress");
    case "blocked":     return chalk.red("blocked");
    case "integration": return chalk.magenta("integ");
    case "tool_call":   return chalk.yellow("tool");
    case "trace":       return chalk.magenta("trace");
    default:            return cat;
  }
}

function formatLatency(entry: AuditEntry): string {
  if (entry.category === "llm" && entry.ttfbMs !== undefined && entry.latencyMs > 0) {
    const ttfb = colorLatency(entry.ttfbMs)(`${entry.ttfbMs}ms`);
    const total = colorLatency(entry.latencyMs)(`${entry.latencyMs}ms`);
    return `${ttfb}/${total}`;
  }

  if (entry.latencyMs <= 0) return chalk.dim("—");
  return colorLatency(entry.latencyMs)(`${entry.latencyMs}ms`);
}

function colorLatency(latencyMs: number): (value: string) => string {
  return latencyMs < 200
    ? chalk.green
    : latencyMs < 1000
      ? chalk.yellow
      : chalk.red;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/**
 * Parse a human-friendly duration string like "1h", "30m", "2d" into a Date.
 * Returns a Date object representing `now - duration`.
 */
function parseSince(duration: string): Date {
  const match = /^(\d+)\s*(s|m|h|d|w)$/.exec(duration.trim());
  if (!match) {
    throw new Error(
      `Invalid duration "${duration}". Use formats like: 30m, 2h, 1d, 1w`,
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

// ---------------------------------------------------------------------------
// Follow mode — live tail
// ---------------------------------------------------------------------------

/**
 * Watch the audit log file and print new entries as they arrive.
 * Runs indefinitely until the user presses Ctrl+C.
 */
async function followAuditLog(opts: LogsOptions, initialEntries: AuditEntry[]): Promise<void> {
  const logFile = auditLogPath();
  let lastSize = 0;
  const entries = [...initialEntries];

  try {
    lastSize = statSync(logFile).size;
  } catch {
    // File may not exist yet
  }

  log.info(`Following ${chalk.dim(logFile)} (Ctrl+C to stop)…`);
  log.blank();

  const watcher = watch(logFile, async () => {
    try {
      const currentSize = statSync(logFile).size;
      if (currentSize <= lastSize) {
        lastSize = currentSize;
        return;
      }

      // Read only the new bytes
      const fd = await import("node:fs").then((fs) =>
        fs.promises.open(logFile, "r"),
      );
      const buf = Buffer.alloc(currentSize - lastSize);
      await fd.read(buf, 0, buf.length, lastSize);
      await fd.close();
      lastSize = currentSize;

      const newLines = buf
        .toString("utf8")
        .split("\n")
        .filter((l) => l.trim());

      let hasNewValidEntries = false;
      for (const line of newLines) {
        try {
          const entry = JSON.parse(line) as AuditEntry;

          // Apply filters
          if (opts.category && entry.category !== opts.category) continue;
          if (opts.verdict && entry.verdict !== opts.verdict) continue;
          if (opts.framework && entry.framework !== opts.framework) continue;
          if (opts.agent && entry.agent !== opts.agent) continue;
          if (opts.query && !matchQuery(entry, opts.query)) continue;
          if (opts.status && !matchStatusCode(entry.statusCode, opts.status)) continue;
          if (opts.latency && !matchLatency(entry.latencyMs, opts.latency)) continue;
          if (entry.method === "INTERNAL") continue;

          if (opts.json) {
            console.log(JSON.stringify(entry));
          } else {
            entries.push(entry);
            hasNewValidEntries = true;
          }
        } catch {
          // Skip malformed lines
        }
      }

      if (hasNewValidEntries && !opts.json) {
        // Enforce tail size limit
        if (entries.length > opts.tail) {
          entries.splice(0, entries.length - opts.tail);
        }

        console.clear();
        printLogsTable(entries);
        log.blank();
        log.info(`Log file: ${chalk.dim(logFile)}`);
        log.info(`Following ${chalk.dim(logFile)} (Ctrl+C to stop)…`);
        log.blank();
      }
    } catch {
      // Non-fatal — file may be rotating
    }
  });

  // Keep running until Ctrl+C
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      watcher.close();
      log.blank();
      log.info("Stopped following audit log.");
      resolve();
    });
  });
}
