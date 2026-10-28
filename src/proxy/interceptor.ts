/**
 * Network Interception Layer
 *
 * When the proxy detects a request to a host not in the active policy it
 * passes the request through this module, which either:
 *
 *   1. (Interactive mode, TTY present) — renders an Inquirer prompt asking
 *      the user to Allow-once / Allow-always / Deny the connection.
 *   2. (Daemon / non-TTY mode) — immediately denies and emits a structured
 *      log entry so the operator can audit what the agent tried to reach.
 *
 * "Allow always" decisions are written back to the active policy file so
 * they survive proxy restarts and do not trigger another prompt.
 */
import inquirer from "inquirer";
import { appendFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../utils/logger.js";
import { readConfig } from "../config/manager.js";
import { parsePolicyFile } from "../policy/engine.js";
import { writePolicyFile, defaultPolicyPath } from "../policy/presets.js";
import type { Policy } from "../policy/engine.js";

export interface InterceptedRequest {
  method: string;
  /** Full URL or host:port for CONNECT requests */
  url: string;
  host: string;
  timestamp: Date;
}

export type ApprovalDecision = "allow_once" | "allow_always" | "deny";

/** Path where blocked requests are appended (JSONL format). */
const BLOCK_LOG = join(homedir(), ".silo", "blocked-requests.jsonl");

/**
 * Callback invoked when "allow_always" persists a new rule to the policy
 * file. The daemon hooks this to re-compile the policy without a restart.
 */
let _onPolicyUpdated: (() => void) | null = null;

/**
 * Register a callback that is invoked after an "allow_always" decision
 * writes a new rule to the policy file. The daemon uses this to trigger
 * a policy recompile without a full restart.
 */
export function onPolicyUpdated(cb: () => void): void {
  _onPolicyUpdated = cb;
}

interface QueuedPrompt {
  id: string;
  method: string;
  url: string;
  host: string;
  timestamp: Date;
  resolve: (decision: ApprovalDecision) => void;
  timeoutId: NodeJS.Timeout;
}

const pendingPrompts = new Map<string, QueuedPrompt>();
let lastPollTime = 0;

export function registerPromptPoll(): void {
  lastPollTime = Date.now();
}

export function isPromptListenerActive(): boolean {
  return Date.now() - lastPollTime < 3000; // active if polled in the last 3s
}

export function getPendingPrompts() {
  return Array.from(pendingPrompts.values()).map((p) => ({
    id: p.id,
    method: p.method,
    url: p.url,
    host: p.host,
    timestamp: p.timestamp,
  }));
}

export function submitPromptDecision(id: string, decision: ApprovalDecision): boolean {
  const queued = pendingPrompts.get(id);
  if (!queued) return false;
  if (decision !== "allow_once" && decision !== "allow_always" && decision !== "deny") {
    return false;
  }
  clearTimeout(queued.timeoutId);
  queued.resolve(decision);
  pendingPrompts.delete(id);
  return true;
}

/**
 * Decide whether to allow or deny a request that failed the policy check.
 *
 * In TTY mode the user is prompted interactively.
 * In daemon/pipe mode the request is queued for a foreground listener if active,
 * otherwise immediately denied.
 */
export async function promptApproveOrDeny(
  req: InterceptedRequest,
): Promise<ApprovalDecision> {
  await appendBlockLog(req, /* preliminaryDecision */ "pending");

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    if (!isPromptListenerActive()) {
      // Running headless with no active CLI listener — auto-deny immediately
      await appendBlockLog(req, "deny");
      log.warn(`[proxy] blocked headless ${req.method} ${req.url} (no listener active)`);
      return "deny";
    }

    // Queue request and await decision from foreground listener
    return new Promise<ApprovalDecision>((resolve) => {
      const id = randomUUID();
      const timeoutId = setTimeout(async () => {
        pendingPrompts.delete(id);
        await appendBlockLog(req, "deny");
        log.warn(`[proxy] blocked headless ${req.method} ${req.url} (prompt timeout)`);
        resolve("deny");
      }, 30000); // 30s timeout

      pendingPrompts.set(id, {
        id,
        method: req.method,
        url: req.url,
        host: req.host,
        timestamp: req.timestamp,
        resolve: async (decision) => {
          await appendBlockLog(req, decision);
          if (decision === "allow_always") {
            await persistAllowAlways(req.host);
          }
          resolve(decision);
        },
        timeoutId,
      });

      log.warn(`[proxy] blocked headless ${req.method} ${req.url} (queued for approval)`);
    });
  }

  // Interactive path — show TUI prompt
  console.log(); // breathing room
  log.warn(`Sandbox is requesting access to an unauthorised host`);
  console.log(`  Method : ${req.method}`);
  console.log(`  Host   : ${req.host}`);
  console.log(`  URL    : ${req.url}`);
  console.log();

  const { decision } = await inquirer.prompt<{ decision: ApprovalDecision }>([
    {
      type: "list",
      name: "decision",
      message: "How should this request be handled?",
      choices: [
        { name: "Allow once   (this request only)", value: "allow_once" },
        { name: "Allow always (add to active policy)", value: "allow_always" },
        { name: "Deny         (block this request)", value: "deny" },
      ],
      default: "deny",
    },
  ]);

  await appendBlockLog(req, decision);

  // Persist "allow_always" to the active policy file
  if (decision === "allow_always") {
    await persistAllowAlways(req.host);
  }

  return decision;
}

/**
 * Write an "allow" rule for the given host into the active policy file.
 * Creates a new policy file if none exists.
 */
async function persistAllowAlways(host: string): Promise<void> {
  try {
    const config = readConfig();
    const targetPath = resolve(config?.sandbox.policyFile ?? defaultPolicyPath());

    // Load existing policy or bootstrap a new one
    let policy: Policy;
    if (existsSync(targetPath)) {
      policy = parsePolicyFile(targetPath);
    } else {
      policy = {
        version: "1",
        name: "custom",
        description: "Generated by SILO interceptor",
        default: "deny",
        rules: [
          { host: "llm.gateway", action: "allow", comment: "SILO inference proxy" },
        ],
      };
    }

    // Skip if a rule for this exact host already exists
    if (policy.rules.some((r) => r.host === host)) {
      log.debug(`[interceptor] rule for "${host}" already exists in policy`);
      return;
    }

    // Append the new rule
    const updated: Policy = {
      ...policy,
      rules: [
        ...policy.rules,
        { host, action: "allow", comment: `Added by interceptor (allow always)` },
      ],
    };

    writePolicyFile(targetPath, updated);
    log.info(`[interceptor] added "${host}" → allow to ${targetPath}`);

    // Notify the daemon to recompile the policy
    _onPolicyUpdated?.();
  } catch (err) {
    // Non-fatal — the request is already allowed for this invocation
    log.error(`[interceptor] failed to persist allow_always: ${String(err)}`);
  }
}

/**
 * Persist a blocked-request entry to the JSONL audit log.
 * This file is never truncated — rotate it manually if needed.
 */
async function appendBlockLog(
  req: InterceptedRequest,
  decision: string,
): Promise<void> {
  try {
    const entry = JSON.stringify({
      timestamp: req.timestamp.toISOString(),
      method: req.method,
      host: req.host,
      url: req.url,
      decision,
    });
    await appendFile(BLOCK_LOG, entry + "\n", "utf8");
  } catch {
    // Non-fatal — logging failure should never block the proxy decision
  }
}
