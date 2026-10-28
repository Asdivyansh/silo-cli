import { Command } from "commander";
import { assertNodeVersion } from "./utils/system.js";
import "./frameworks/definitions.js";
import { loadCustomFrameworks } from "./frameworks/custom.js";
import { runOnboard } from "./commands/onboard.js";
import { runStart } from "./commands/start.js";
import { runStop } from "./commands/stop.js";
import { runConnect } from "./commands/connect.js";
import { runStatus } from "./commands/status.js";
import { runBuild } from "./commands/build.js";
import { runList } from "./commands/list.js";
import { runAgent } from "./commands/run.js";
import {
  runPolicyList,
  runPolicyShow,
  runPolicyApply,
  runPolicyRemove,
  runPolicyReload,
  runPolicyAdd,
} from "./commands/policy.js";
import { runLogs } from "./commands/logs.js";
import {
  runIntegrationsAdd,
  runIntegrationsList,
  runIntegrationsRemove,
  runIntegrationsTest,
  runIntegrationsTemplates,
} from "./commands/integrations.js";
import {
  runFrameworksList,
  runFrameworksInfo,
} from "./commands/frameworks.js";
import {
  runSnapshotCreate,
  runSnapshotList,
  runSnapshotRollback,
  runSnapshotDelete,
} from "./commands/snapshot.js";
import { runDoctor } from "./commands/doctor.js";
import { runQuickstart } from "./commands/quickstart.js";
import { runTraces } from "./commands/traces.js";

assertNodeVersion(18);

// Register built-in framework definitions, then user-provided ones from
// ~/.silo/frameworks/ (customs may override built-ins).
loadCustomFrameworks();

const program = new Command();

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

program
  .name("silo")
  .description(
    "Secure CLI platform for running AI agents in isolated Docker sandboxes",
  )
  .version("0.2.0", "-V, --version", "Print version")
  .helpOption("-h, --help", "Show help");

// ── onboard ────────────────────────────────────────────────────────────────
program
  .command("onboard")
  .description(
    "Interactive wizard: configure your LLM provider, API key, and sandbox settings.",
  )
  .option("-f, --force", "Overwrite existing configuration", false)
  .action(async (opts: { force: boolean }) => {
    await runOnboard(opts);
  });

// ── quickstart ─────────────────────────────────────────────────────────────
program
  .command("quickstart")
  .alias("qs")
  .description(
    "Zero-to-sandbox in one command: onboard → build → start → connect.",
  )
  .option("-f, --framework <id>", "Start with a framework (e.g. crewai, aider)")
  .option("--browser", "Use a browser-capable framework image and runtime profile", false)
  .action(async (opts: { framework?: string; browser: boolean }) => {
    await runQuickstart(opts);
  });

// ── doctor ─────────────────────────────────────────────────────────────────
program
  .command("doctor")
  .description(
    "Run diagnostic checks on Docker, proxy, policy, and sandbox health.",
  )
  .action(async () => {
    await runDoctor();
  });

// ── build ──────────────────────────────────────────────────────────────────
program
  .command("build")
  .description("Build the agent sandbox Docker image from sandbox/Dockerfile.")
  .option("-t, --tag <tag>", "Override the image tag (default: silo-sandbox:latest)")
  .option("--no-cache", "Pass --no-cache to docker build")
  .option("-f, --framework <id>", "Build image with a framework pre-installed (e.g. crewai, langgraph)")
  .option("--all-frameworks", "Build images for all supported frameworks", false)
  .option("--browser", "Build a browser-capable framework image", false)
  .action(async (opts: { tag?: string; noCache: boolean; framework?: string; allFrameworks: boolean; browser: boolean }) => {
    await runBuild(opts);
  });

// ── start ──────────────────────────────────────────────────────────────────
program
  .command("start")
  .description(
    "Launch the agent sandbox and the host-side inference proxy daemon.",
  )
  .option(
    "-p, --policy <file>",
    "Path to a YAML policy file (overrides the configured default)",
  )
  .option("--rebuild", "Rebuild the sandbox image before starting", false)
  .option("-n, --name <agent>", "Name for this agent (creates container silo-<name>)")
  .option("-w, --workspace <path>", "Override workspace path for this agent")
  .option("--desktop", "Mount the host Desktop at /host/Desktop (read-write)", false)
  .option("--browser", "Use a browser-capable framework image and runtime profile", false)
  .option(
    "--mount <spec>",
    "Additional host mount: /host/path:/host/name[:ro|rw] (target must be under /host)",
    collectOption,
    [],
  )
  .option("-f, --framework <id>", "Start with a specific agent framework (e.g. crewai, langgraph, aider)")
  .option("--no-logs", "Do not auto-open a log terminal window")
  .action(async (opts: { policy?: string; rebuild: boolean; name?: string; workspace?: string; desktop: boolean; browser: boolean; mount: string[]; framework?: string; logs: boolean }) => {
    await runStart(opts);
  });

// ── stop ───────────────────────────────────────────────────────────────────
program
  .command("stop")
  .description(
    "Stop and remove sandbox container(s), the inference proxy daemon, and " +
    "the Docker bridge network.",
  )
  .option("-n, --name <agent>", "Stop a specific named agent")
  .option("-a, --all", "Stop all running SILO agents", false)
  .action(async (opts: { name?: string; all: boolean }) => {
    await runStop(opts);
  });

// ── connect ────────────────────────────────────────────────────────────────
program
  .command("connect")
  .description("Open an interactive shell inside the running sandbox.")
  .option("-s, --shell <shell>", "Shell binary to use", "/bin/sh")
  .option("-n, --name <agent>", "Connect to a specific named agent")
  .option("--tui", "Launch the active framework's TUI instead of a shell", false)
  .action(async (opts: { shell: string; name?: string; tui: boolean }) => {
    await runConnect({ ...opts, logs: false });
  });

// ── status ─────────────────────────────────────────────────────────────────
program
  .command("status")
  .description(
    "Show sandbox health, LLM configuration, active policy, framework status, and proxy state.",
  )
  .action(async () => {
    await runStatus();
  });

// ── list ───────────────────────────────────────────────────────────────────
program
  .command("list")
  .alias("ls")
  .description("List all running SILO agent containers.")
  .action(async () => {
    await runList();
  });

// ── run ────────────────────────────────────────────────────────────────────
program
  .command("run <task>")
  .description(
    "Run an agent task. Sends the task to the LLM, executes tool calls inside " +
    "the sandbox, and loops until completion.",
  )
  .option("-m, --max-turns <n>", "Maximum conversation turns", "10")
  .option("-n, --name <agent>", "Run against a specific named agent")
  .option("-p, --policy <file>", "Policy file override")
  .option("--no-stream", "Disable streaming output")
  .action(async (task: string, opts: { maxTurns: string; name?: string; policy?: string; stream: boolean }) => {
    await runAgent(task, {
      maxTurns: parseInt(opts.maxTurns, 10),
      name: opts.name,
      policy: opts.policy,
      stream: opts.stream,
    });
  });

// ── frameworks ─────────────────────────────────────────────────────────────
const frameworksCmd = program
  .command("frameworks")
  .alias("fw")
  .description("List and manage supported agent frameworks.");

frameworksCmd
  .command("list")
  .description("List all supported agent frameworks.")
  .action(async () => { await runFrameworksList(); });

frameworksCmd
  .command("info <id>")
  .description("Show detailed information about a specific framework.")
  .action(async (id: string) => { await runFrameworksInfo(id); });

// Default: `silo frameworks` without subcommand shows the list
frameworksCmd.action(async () => { await runFrameworksList(); });

// ── snapshot ──────────────────────────────────────────────────────────────
const snapshotCmd = program
  .command("snapshot")
  .description("Create and manage sandbox snapshots for rollback.");

snapshotCmd
  .command("create <name>")
  .description("Create a named snapshot of the running sandbox.")
  .option("-n, --name <agent>", "Snapshot a specific named agent")
  .action(async (snapshotName: string, opts: { name?: string }) => {
    await runSnapshotCreate(snapshotName, opts);
  });

snapshotCmd
  .command("list")
  .description("List all saved snapshots.")
  .action(async () => { await runSnapshotList(); });

snapshotCmd
  .command("rollback <snapshot>")
  .description("Stop the current sandbox and restore from a snapshot.")
  .option("-n, --name <agent>", "Rollback a specific named agent")
  .action(async (snapshotName: string, opts: { name?: string }) => {
    await runSnapshotRollback(snapshotName, opts);
  });

snapshotCmd
  .command("delete <snapshot>")
  .description("Delete a saved snapshot.")
  .option("-n, --name <agent>", "Delete snapshot for a specific named agent")
  .action(async (snapshotName: string, opts: { name?: string }) => {
    await runSnapshotDelete(snapshotName, opts);
  });

// ── policy ─────────────────────────────────────────────────────────────────
const policyCmd = program
  .command("policy")
  .description("Manage sandbox egress policies.");

policyCmd
  .command("list")
  .description("List all built-in policy presets.")
  .action(() => { runPolicyList(); });

policyCmd
  .command("show")
  .description("Print the active policy rules.")
  .action(() => { runPolicyShow(); });

policyCmd
  .command("apply <preset>")
  .description(
    "Merge a preset into the active policy (e.g. pypi, npm, github).",
  )
  .action((preset: string) => { runPolicyApply(preset); });

policyCmd
  .command("remove <preset>")
  .description("Remove a preset's rules from the active policy.")
  .action((preset: string) => { runPolicyRemove(preset); });

policyCmd
  .command("reload")
  .description("Send SIGHUP to the running proxy daemon to hot-reload the policy.")
  .action(async () => { await runPolicyReload(); });

policyCmd
  .command("add <host>")
  .description(
    "Add a single host rule to the active policy (e.g. silo policy add api.github.com).",
  )
  .option("--action <action>", "Rule action: allow or deny", "allow")
  .option("--comment <text>", "Optional comment for the rule")
  .action(
    (host: string, opts: { action?: string; comment?: string }) => {
      runPolicyAdd(host, opts);
    },
  );

// ── logs ──────────────────────────────────────────────────────────────────────────
program
  .command("logs")
  .description(
    "View the unified audit trail: LLM calls, egress, tool calls, and framework traces.",
  )
  .option("-n, --tail <count>", "Number of entries to show", "20")
  .option("-c, --category <cat>", "Filter by category (llm, llm_message, egress, blocked, tool_call, trace, integration)")
  .option("-v, --verdict <verdict>", "Filter by verdict (allow, deny)")
  .option("-s, --since <duration>", "Show entries since (e.g. 30m, 2h, 1d)")
  .option("-f, --framework <id>", "Filter by framework (e.g. crewai, langgraph)")
  .option("-a, --agent <name>", "Filter by agent name")
  .option("-F, --follow", "Follow the audit log in real-time (like tail -f)", false)
  .option("--json", "Output raw JSONL for piping", false)
  .option("-i, --interactive", "Launch interactive TUI log explorer", false)
  .option("-q, --query <search>", "Search within URL, host, or payloads")
  .option("--status <range>", "Filter by status code(s) (e.g., 200, 4xx, 500-599)")
  .option("--latency <min-max>", "Filter by latency range in ms (e.g., 100-500, 1000+)")
  .action(
    async (opts: {
      tail: string;
      category?: string;
      verdict?: string;
      since?: string;
      framework?: string;
      agent?: string;
      follow: boolean;
      json: boolean;
      interactive: boolean;
      query?: string;
      status?: string;
      latency?: string;
    }) => {
      await runLogs({
        tail: parseInt(opts.tail, 10),
        category: opts.category,
        verdict: opts.verdict,
        since: opts.since,
        framework: opts.framework,
        agent: opts.agent,
        follow: opts.follow,
        json: opts.json,
        interactive: opts.interactive,
        query: opts.query,
        status: opts.status,
        latency: opts.latency,
      });
    },
  );

// ── traces ────────────────────────────────────────────────────────────────────
program
  .command("traces")
  .description(
    "View framework-level trace events (agent lifecycle, tool calls, delegations).",
  )
  .option("-n, --tail <count>", "Number of entries to show", "30")
  .option("-f, --framework <id>", "Filter by framework (e.g. crewai, langgraph)")
  .option("-e, --event <type>", "Filter by event (tool_call, agent_start, node_enter, etc.)")
  .option("-a, --agent <name>", "Filter by agent/node name")
  .option("-s, --since <duration>", "Show entries since (e.g. 30m, 2h, 1d)")
  .option("--json", "Output raw JSONL for piping", false)
  .action(
    async (opts: {
      tail: string;
      framework?: string;
      event?: string;
      agent?: string;
      since?: string;
      json: boolean;
    }) => {
      await runTraces({
        tail: parseInt(opts.tail, 10),
        framework: opts.framework,
        event: opts.event,
        agent: opts.agent,
        since: opts.since,
        json: opts.json,
      });
    },
  );

// ── integrations ───────────────────────────────────────────────────────────────
const intCmd = program
  .command("integrations")
  .alias("int")
  .description("Manage credential-managed integrations (Slack, GitHub, HubSpot, etc.).");

intCmd
  .command("add <service>")
  .description(
    "Add a new integration. Uses a built-in template if available, or prompts for all fields.",
  )
  .action(async (service: string) => {
    await runIntegrationsAdd(service);
  });

intCmd
  .command("list")
  .description("List all configured integrations.")
  .action(async () => {
    await runIntegrationsList();
  });

intCmd
  .command("remove <name>")
  .description("Remove a configured integration.")
  .action(async (name: string) => {
    await runIntegrationsRemove(name);
  });

intCmd
  .command("test <name>")
  .description("Test connectivity to an integration's API endpoint.")
  .action(async (name: string) => {
    await runIntegrationsTest(name);
  });

intCmd
  .command("templates")
  .description("List available built-in integration templates.")
  .action(() => {
    runIntegrationsTemplates();
  });

// ── Global error handler ───────────────────────────────────────────────────
program.exitOverride();

try {
  await program.parseAsync(process.argv);
} catch (err) {
  if (err instanceof Error && err.constructor.name !== "CommanderError") {
    console.error(`\n  ${err.message}\n`);
    process.exit(1);
  }
}
