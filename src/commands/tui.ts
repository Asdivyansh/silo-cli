import readline from "node:readline";
import chalk from "chalk";
import { type AuditEntry, type AuditCategory } from "../audit/audit.js";

interface TuiState {
  entries: AuditEntry[];
  filteredEntries: AuditEntry[];
  selectedIndex: number;
  scrollOffset: number;
  viewState: "list" | "detail" | "filter";
  filterQuery: string;
  filterCategory: AuditCategory | "all";
  filterVerdict: "allow" | "deny" | "all";
}

/**
 * Launch the full-screen interactive TUI log viewer.
 */
export async function launchInteractiveTui(
  initialEntries: AuditEntry[],
  reloadLogs: () => Promise<AuditEntry[]>,
): Promise<void> {
  // Store original stdin settings
  const stdin = process.stdin;
  if (!stdin.isTTY || !process.stdout.isTTY) {
    console.error("Interactive mode requires a TTY terminal.");
    process.exitCode = 1;
    return;
  }

  // Setup state
  const state: TuiState = {
    entries: initialEntries,
    filteredEntries: [],
    selectedIndex: 0,
    scrollOffset: 0,
    viewState: "list",
    filterQuery: "",
    filterCategory: "all",
    filterVerdict: "all",
  };

  // Skip INTERNAL events
  state.entries = state.entries.filter((e) => e.method !== "INTERNAL");
  applyFilters(state);

  // Initialize selected index to the last element (most recent log)
  if (state.filteredEntries.length > 0) {
    state.selectedIndex = state.filteredEntries.length - 1;
  }

  await new Promise<void>((resolve, reject) => {
    let closed = false;
    const wasRaw = stdin.isRaw;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      process.stdout.removeListener("resize", onResize);
      process.removeListener("SIGINT", onSigint);
      stdin.removeListener("keypress", onKeypress);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      process.stdout.write("\u001B[?1049l"); // Leave alternate screen
      process.stdout.write("\u001B[?25h");   // Show cursor
    };

    const finish = () => {
      cleanup();
      resolve();
    };

    const fail = (err: unknown) => {
      cleanup();
      reject(err);
    };

    const safeDraw = () => {
      try {
        draw(state);
      } catch (err) {
        fail(err);
      }
    };

    const onResize = () => {
      safeDraw();
    };

    const onSigint = () => {
      finish();
    };

    const onKeypress = (str: string, key: readline.Key) => {
      void handleKeypress(str, key).catch(fail);
    };

    const handleKeypress = async (str: string, key: readline.Key) => {
      if (key.ctrl && key.name === "c") {
        finish();
        return;
      }

      if (state.viewState === "filter") {
        // In filter input mode, handle characters
        if (key.name === "return") {
          state.viewState = "list";
          applyFilters(state);
          state.selectedIndex = Math.max(0, state.filteredEntries.length - 1);
          state.scrollOffset = 0;
          safeDraw();
        } else if (key.name === "escape") {
          state.viewState = "list";
          safeDraw();
        } else if (key.name === "backspace") {
          state.filterQuery = state.filterQuery.slice(0, -1);
          safeDraw();
        } else if (str && str.length === 1 && !key.ctrl && !key.meta) {
          state.filterQuery += str;
          safeDraw();
        }
        return;
      }

      if (state.viewState === "detail") {
        // Detail view controls
        if (key.name === "escape" || key.name === "backspace") {
          state.viewState = "list";
          safeDraw();
        } else if (key.name === "q") {
          finish();
        } else if (key.name === "up") {
          // Move to previous entry details
          if (state.selectedIndex > 0) {
            state.selectedIndex--;
            safeDraw();
          }
        } else if (key.name === "down") {
          // Move to next entry details
          if (state.selectedIndex < state.filteredEntries.length - 1) {
            state.selectedIndex++;
            safeDraw();
          }
        }
        return;
      }

      // List view controls
      switch (key.name) {
        case "q":
        case "escape":
          finish();
          return;

        case "up":
          if (state.selectedIndex > 0) {
            state.selectedIndex--;
            adjustScroll(state);
            safeDraw();
          }
          break;

        case "down":
          if (state.selectedIndex < state.filteredEntries.length - 1) {
            state.selectedIndex++;
            adjustScroll(state);
            safeDraw();
          }
          break;

        case "pageup":
          state.selectedIndex = Math.max(0, state.selectedIndex - getPageSize());
          adjustScroll(state);
          safeDraw();
          break;

        case "pagedown":
          state.selectedIndex = Math.min(
            Math.max(0, state.filteredEntries.length - 1),
            state.selectedIndex + getPageSize(),
          );
          adjustScroll(state);
          safeDraw();
          break;

        case "home":
          state.selectedIndex = 0;
          adjustScroll(state);
          safeDraw();
          break;

        case "end":
          state.selectedIndex = Math.max(0, state.filteredEntries.length - 1);
          adjustScroll(state);
          safeDraw();
          break;

        case "return":
          if (state.filteredEntries.length > 0) {
            state.viewState = "detail";
            safeDraw();
          }
          break;

        case "f":
          state.viewState = "filter";
          safeDraw();
          break;

        case "r":
          // Refresh logs from disk
          process.stdout.write(`\r${chalk.yellow("Refreshing...")}`);
          try {
            const fresh = await reloadLogs();
            state.entries = fresh.filter((e) => e.method !== "INTERNAL");
            applyFilters(state);
            state.selectedIndex = Math.min(
              state.selectedIndex,
              Math.max(0, state.filteredEntries.length - 1),
            );
            adjustScroll(state);
          } catch {
            // Keep old logs on load failure
          }
          safeDraw();
          break;

        case "c":
          // Cycle categories: all -> llm -> llm_message -> egress -> blocked -> integration -> tool_call -> trace
          const cats: Array<AuditCategory | "all"> = ["all", "llm", "llm_message", "egress", "blocked", "integration", "tool_call", "trace"];
          const currCatIdx = cats.indexOf(state.filterCategory);
          state.filterCategory = cats[(currCatIdx + 1) % cats.length]!;
          applyFilters(state);
          state.selectedIndex = Math.min(state.selectedIndex, Math.max(0, state.filteredEntries.length - 1));
          adjustScroll(state);
          safeDraw();
          break;

        case "v":
          // Cycle verdict: all -> allow -> deny
          const verdicts: Array<"all" | "allow" | "deny"> = ["all", "allow", "deny"];
          const currVerIdx = verdicts.indexOf(state.filterVerdict);
          state.filterVerdict = verdicts[(currVerIdx + 1) % verdicts.length]!;
          applyFilters(state);
          state.selectedIndex = Math.min(state.selectedIndex, Math.max(0, state.filteredEntries.length - 1));
          adjustScroll(state);
          safeDraw();
          break;
      }
    };

    try {
      // Enter alternate screen buffer and hide cursor
      process.stdout.write("\u001B[?1049h"); // Alternate screen
      process.stdout.write("\u001B[?25l");   // Hide cursor

      // Setup raw mode for keypress events
      readline.emitKeypressEvents(stdin);
      stdin.setRawMode(true);
      stdin.resume();

      process.stdout.on("resize", onResize);
      process.on("SIGINT", onSigint);
      stdin.on("keypress", onKeypress);

      // Draw initial frame
      safeDraw();
    } catch (err) {
      fail(err);
    }
  });
}

function getPageSize(): number {
  return Math.max(1, (process.stdout.rows ?? 24) - 7);
}

function adjustScroll(state: TuiState) {
  const limit = getPageSize();
  if (state.selectedIndex < state.scrollOffset) {
    state.scrollOffset = state.selectedIndex;
  } else if (state.selectedIndex >= state.scrollOffset + limit) {
    state.scrollOffset = state.selectedIndex - limit + 1;
  }
}

function applyFilters(state: TuiState) {
  const query = state.filterQuery.toLowerCase().trim();
  state.filteredEntries = state.entries.filter((e) => {
    // Category filter
    if (state.filterCategory !== "all" && e.category !== state.filterCategory) {
      return false;
    }
    // Verdict filter
    if (state.filterVerdict !== "all" && e.verdict !== state.filterVerdict) {
      return false;
    }
    // Query search
    if (query) {
      const match =
        (e.host?.toLowerCase().includes(query) ?? false) ||
        (e.url?.toLowerCase().includes(query) ?? false) ||
        (e.method?.toLowerCase().includes(query) ?? false) ||
        (e.model?.toLowerCase().includes(query) ?? false) ||
        (e.llmRequestId?.toLowerCase().includes(query) ?? false) ||
        (e.errorPreview?.toLowerCase().includes(query) ?? false) ||
        (e.messageRole?.toLowerCase().includes(query) ?? false) ||
        (e.messagePreview?.toLowerCase().includes(query) ?? false) ||
        (e.messageName?.toLowerCase().includes(query) ?? false) ||
        (e.service?.toLowerCase().includes(query) ?? false) ||
        (e.toolName?.toLowerCase().includes(query) ?? false) ||
        (e.toolArgs?.toLowerCase().includes(query) ?? false) ||
        (e.agent?.toLowerCase().includes(query) ?? false) ||
        (e.traceEvent?.toLowerCase().includes(query) ?? false) ||
        (e.traceResult?.toLowerCase().includes(query) ?? false) ||
        (e.framework?.toLowerCase().includes(query) ?? false);
      if (!match) return false;
    }
    return true;
  });
}

function draw(state: TuiState) {
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;

  // Clear alternate buffer screen
  process.stdout.write("\u001B[2J\u001B[H");

  if (state.viewState === "filter") {
    drawFilterPrompt(state);
    return;
  }

  if (state.viewState === "detail") {
    drawDetailView(state, cols, rows);
    return;
  }

  drawListView(state, cols, rows);
}

function drawFilterPrompt(state: TuiState) {
  console.log(chalk.bold.cyan("=== Filter Logs ==="));
  console.log("");
  console.log("Enter search query (matches URL, host, tools, payload text):");
  console.log(chalk.yellow(`> ${state.filterQuery}_`));
  console.log("");
  console.log(chalk.dim("Press [Enter] to apply, [Escape] to cancel."));
}

function drawListView(state: TuiState, cols: number, rows: number) {
  // Title bar
  const header = ` SILO Logs Dashboard | ${state.filteredEntries.length} entries (Total: ${state.entries.length}) `;
  const cycles = `[C] Cat: ${chalk.bold(state.filterCategory)} | [V] Verdict: ${chalk.bold(state.filterVerdict)} | [F] Search: ${state.filterQuery ? chalk.yellow(state.filterQuery) : chalk.dim("none")}`;
  console.log(chalk.bgCyan.black(" ".repeat(Math.max(0, Math.floor((cols - header.length) / 2))) + header + " ".repeat(Math.max(0, Math.ceil((cols - header.length) / 2)))));
  console.log(chalk.dim("─".repeat(cols)));
  console.log(cycles);
  console.log(chalk.dim("─".repeat(cols)));

  // Table Headers
  const timeW = 9;
  const catW = 10;
  const verdW = 8;
  const methodW = 8;
  const statusW = 8;
  const latencyW = 9;
  const hostW = Math.max(20, cols - (timeW + catW + verdW + methodW + statusW + latencyW + 10));

  const headers = [
    "Time".padEnd(timeW),
    "Category".padEnd(catW),
    "Verdict".padEnd(verdW),
    "Method".padEnd(methodW),
    "Host/Tool".padEnd(hostW),
    "Status".padEnd(statusW),
    "Latency".padEnd(latencyW),
  ];
  console.log(chalk.bold(headers.join(" ")));
  console.log(chalk.dim("─".repeat(cols)));

  const limit = Math.max(1, rows - 7);
  const pageEntries = state.filteredEntries.slice(state.scrollOffset, state.scrollOffset + limit);

  pageEntries.forEach((entry, index) => {
    const actualIndex = state.scrollOffset + index;
    const isSelected = actualIndex === state.selectedIndex;

    const timeStr = formatTime(entry.timestamp).padEnd(timeW);
    const catStr = formatCategory(entry.category, entry.traceEvent).padEnd(catW);
    const verdStr = (entry.verdict === "allow" ? chalk.green("allow") : chalk.red("deny")).padEnd(verdW);
    
    let methodStr = entry.method;
    if (entry.category === "tool_call") methodStr = "TOOL";
    if (entry.category === "llm_message") methodStr = "MSG";
    if (entry.category === "trace") methodStr = "TRACE";
    methodStr = methodStr.padEnd(methodW);

    let hostDisplay = entry.host;
    if (entry.category === "tool_call") {
      hostDisplay = `⚡ ${entry.toolName ?? "unknown"}`;
    } else if (entry.category === "llm_message") {
      const idx = entry.messageIndex === -1 ? "sys" : String(entry.messageIndex ?? "—");
      hostDisplay = `${idx}:${entry.messageRole ?? "message"} ${cleanDisplay(entry.messagePreview ?? "")}`;
    } else if (entry.category === "trace") {
      hostDisplay = `⚓ ${entry.agent ?? "main"}: ${entry.traceEvent ?? "event"}`;
    }
    const hostStr = truncate(hostDisplay, hostW).padEnd(hostW);

    const statusVal = entry.statusCode > 0 ? String(entry.statusCode) : "—";
    const statusColor = entry.statusCode >= 200 && entry.statusCode < 300
      ? chalk.green
      : entry.statusCode >= 300 && entry.statusCode < 400
        ? chalk.yellow
        : chalk.red;
    const statusStr = (entry.statusCode > 0 ? statusColor(statusVal) : chalk.dim(statusVal)).padEnd(statusW);

    const latencyVal = entry.latencyMs > 0 ? `${entry.latencyMs}ms` : "—";
    const latencyColor = entry.latencyMs < 200
      ? chalk.green
      : entry.latencyMs < 1000
        ? chalk.yellow
        : chalk.red;
    const latencyStr = (entry.latencyMs > 0 ? latencyColor(latencyVal) : chalk.dim(latencyVal)).padEnd(latencyW);

    let line = `${timeStr} ${catStr} ${verdStr} ${methodStr} ${hostStr} ${statusStr} ${latencyStr}`;
    
    if (isSelected) {
      // Highlight selected line
      console.log(chalk.bgWhite.black(line));
    } else {
      console.log(line);
    }
  });

  // Footer bar
  const footerRow = Math.max(1, rows - 1);
  const instruction = " [↑/↓] Scroll | [Enter] Inspect Detail | [F] Filter Query | [C] Cycle Category | [V] Cycle Verdict | [R] Refresh | [Q] Exit";
  process.stdout.write(`\u001B[${footerRow};1H` + chalk.bgCyan.black(instruction.padEnd(cols).slice(0, cols)));
}

function drawDetailView(state: TuiState, cols: number, rows: number) {
  const entry = state.filteredEntries[state.selectedIndex];
  if (!entry) {
    state.viewState = "list";
    draw(state);
    return;
  }

  // Print detail header
  const title = ` Log Entry Detail (${state.selectedIndex + 1}/${state.filteredEntries.length}) `;
  console.log(chalk.bgCyan.black(" ".repeat(Math.max(0, Math.floor((cols - title.length) / 2))) + title + " ".repeat(Math.max(0, Math.ceil((cols - title.length) / 2)))));
  console.log(chalk.dim("─".repeat(cols)));

  console.log(`${chalk.bold("Timestamp:")}   ${entry.timestamp}`);
  console.log(`${chalk.bold("Session ID:")}  ${entry.sessionId}`);
  console.log(`${chalk.bold("Category:")}    ${formatCategory(entry.category, entry.traceEvent)}`);
  console.log(`${chalk.bold("Verdict:")}     ${entry.verdict === "allow" ? chalk.green("ALLOW") : chalk.red("DENY")}`);
  console.log(`${chalk.bold("Method:")}      ${entry.method}`);
  console.log(`${chalk.bold("Host:")}        ${entry.host}`);
  console.log(`${chalk.bold("URL:")}         ${chalk.dim(entry.url)}`);
  
  const statusColor = entry.statusCode >= 200 && entry.statusCode < 300
    ? chalk.green
    : entry.statusCode >= 300 && entry.statusCode < 400
      ? chalk.yellow
      : chalk.red;
  console.log(`${chalk.bold("Status:")}      ${entry.statusCode > 0 ? statusColor(entry.statusCode) : chalk.dim("—")}`);
  
  const latencyColor = entry.latencyMs < 200
    ? chalk.green
    : entry.latencyMs < 1000
      ? chalk.yellow
      : chalk.red;
  console.log(`${chalk.bold("Latency:")}     ${entry.latencyMs > 0 ? latencyColor(`${entry.latencyMs}ms`) : chalk.dim("—")}`);
  if (entry.ttfbMs !== undefined) console.log(`${chalk.bold("TTFB:")}        ${entry.ttfbMs}ms`);
  if (entry.llmRequestId) console.log(`${chalk.bold("LLM Req ID:")}  ${entry.llmRequestId}`);
  if (entry.requestBytes !== undefined) console.log(`${chalk.bold("Req Bytes:")}   ${entry.requestBytes}`);
  if (entry.responseBytes !== undefined) console.log(`${chalk.bold("Resp Bytes:")}  ${entry.responseBytes}`);
  if (entry.errorPreview) console.log(`${chalk.bold("Error:")}       ${entry.errorPreview}`);

  if (entry.model) console.log(`${chalk.bold("Model:")}       ${entry.model}`);
  if (entry.service) console.log(`${chalk.bold("Service:")}     ${entry.service}`);
  if (entry.framework) console.log(`${chalk.bold("Framework:")}   ${entry.framework}`);
  if (entry.agent) console.log(`${chalk.bold("Agent:")}       ${entry.agent}`);

  if (entry.toolName) {
    console.log("");
    console.log(chalk.bold.yellow("--- Tool Call Info ---"));
    console.log(`${chalk.bold("Tool Name:")}   ${entry.toolName}`);
    if (entry.toolCallId) console.log(`${chalk.bold("Tool Call ID:")} ${entry.toolCallId}`);
    if (entry.toolArgs) {
      console.log(`${chalk.bold("Arguments:")}`);
      try {
        const parsed = JSON.parse(entry.toolArgs);
        const pretty = JSON.stringify(parsed, null, 2);
        pretty.split("\n").forEach((l) => console.log("  " + l));
      } catch {
        console.log("  " + entry.toolArgs);
      }
    }
  }

  if (entry.category === "llm_message") {
    console.log("");
    console.log(chalk.bold.cyan("--- LLM Message ---"));
    console.log(`${chalk.bold("Index:")}       ${entry.messageIndex ?? "—"}`);
    console.log(`${chalk.bold("Role:")}        ${entry.messageRole ?? "—"}`);
    console.log(`${chalk.bold("Type:")}        ${entry.messageContentType ?? "—"}`);
    console.log(`${chalk.bold("Chars:")}       ${entry.messageChars ?? "—"}`);
    if (entry.messageName) console.log(`${chalk.bold("Name:")}        ${entry.messageName}`);
    if (entry.messagePreview) {
      console.log(`${chalk.bold("Preview:")}`);
      console.log("  " + cleanDisplay(entry.messagePreview));
    }
  }

  if (entry.traceEvent) {
    console.log("");
    console.log(chalk.bold.magenta("--- Trace Info ---"));
    console.log(`${chalk.bold("Trace Event:")}  ${entry.traceEvent}`);
    if (entry.traceResult) {
      console.log(`${chalk.bold("Result:")}`);
      try {
        const parsed = JSON.parse(entry.traceResult);
        const pretty = JSON.stringify(parsed, null, 2);
        pretty.split("\n").forEach((l) => console.log("  " + l));
      } catch {
        console.log("  " + entry.traceResult);
      }
    }
  }

  // Footer navigation
  const footerRow = Math.max(1, rows - 1);
  const instruction = " [↑/↓] Prev/Next Detail | [Escape/Backspace] Return to list | [Q] Exit";
  process.stdout.write(`\u001B[${footerRow};1H` + chalk.bgCyan.black(instruction.padEnd(cols).slice(0, cols)));
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

function formatCategory(cat: string, traceEvent?: string): string {
  switch (cat) {
    case "llm":         return chalk.cyan("llm");
    case "llm_message": return chalk.cyan("msg");
    case "egress":      return chalk.blue("egress");
    case "blocked":     return chalk.red("blocked");
    case "integration": return chalk.magenta("integ");
    case "tool_call":   return chalk.yellow("tool");
    case "trace":       return traceEvent ? chalk.magenta(truncate(traceEvent, 9)) : chalk.magenta("trace");
    default:            return cat;
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function cleanDisplay(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "");
}
