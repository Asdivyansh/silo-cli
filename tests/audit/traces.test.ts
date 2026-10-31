import { describe, it, expect, vi, beforeEach } from "vitest";
import { processTrace } from "../../src/audit/traces.js";

// Mock the audit module so processTrace doesn't write to disk
vi.mock("../../src/audit/audit.js", () => ({
  appendAuditEntry: vi.fn().mockResolvedValue(undefined),
  getSessionId: vi.fn().mockReturnValue("test-session-id"),
}));

import { appendAuditEntry } from "../../src/audit/audit.js";

describe("processTrace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Validation ──────────────────────────────────────────────────────────

  it("throws on missing framework", async () => {
    await expect(
      processTrace({ framework: "", event: "tool_call" }),
    ).rejects.toThrow("Missing required field: framework");
  });

  it("throws on invalid event type", async () => {
    await expect(
      processTrace({ framework: "crewai", event: "invalid_event" }),
    ).rejects.toThrow("Invalid event type");
  });

  it("accepts all valid event types", async () => {
    const validEvents = [
      "tool_call", "agent_start", "agent_end",
      "task_start", "task_end", "delegation",
      "node_enter", "node_exit", "step", "error", "custom",
    ];

    for (const event of validEvents) {
      const result = await processTrace({ framework: "test", event });
      expect(result.event).toBe(event);
    }
  });

  // ── Category routing ────────────────────────────────────────────────────

  it("routes tool_call events to tool_call category", async () => {
    await processTrace({
      framework: "crewai",
      event: "tool_call",
      tool: "search_web",
    });

    expect(appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "tool_call",
        toolName: "search_web",
      }),
    );
  });

  it("routes non-tool events to trace category", async () => {
    await processTrace({
      framework: "crewai",
      event: "agent_start",
      agent: "Researcher",
    });

    expect(appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "trace",
        traceEvent: "agent_start",
        agent: "Researcher",
      }),
    );
  });

  // ── Return value ────────────────────────────────────────────────────────

  it("returns traceId and event", async () => {
    const result = await processTrace({
      framework: "langgraph",
      event: "node_enter",
      agent: "planner",
    });

    expect(result.traceId).toBeDefined();
    expect(typeof result.traceId).toBe("string");
    expect(result.traceId.length).toBeGreaterThan(0);
    expect(result.event).toBe("node_enter");
  });

  // ── Audit entry structure ───────────────────────────────────────────────

  it("writes correct audit entry fields for tool_call", async () => {
    await processTrace({
      framework: "crewai",
      event: "tool_call",
      tool: "read_file",
      agent: "Coder",
      args: { path: "/workspace/index.ts" },
      result: "file contents here",
      durationMs: 42,
    });

    expect(appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "TRACE",
        host: "framework",
        category: "tool_call",
        verdict: "allow",
        framework: "crewai",
        agent: "Coder",
        toolName: "read_file",
        latencyMs: 42,
      }),
    );
  });

  it("writes correct audit entry fields for trace events", async () => {
    await processTrace({
      framework: "langgraph",
      event: "node_exit",
      agent: "analyzer",
      result: "analysis complete",
      durationMs: 1500,
    });

    expect(appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "TRACE",
        host: "framework",
        category: "trace",
        traceEvent: "node_exit",
        framework: "langgraph",
        agent: "analyzer",
        traceResult: "analysis complete",
        latencyMs: 1500,
      }),
    );
  });

  // ── Sanitisation ────────────────────────────────────────────────────────

  it("truncates agent name at 200 chars", async () => {
    const longName = "A".repeat(300);
    await processTrace({
      framework: "test",
      event: "agent_start",
      agent: longName,
    });

    expect(appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "A".repeat(200),
      }),
    );
  });

  it("truncates tool name at 200 chars", async () => {
    const longTool = "t".repeat(300);
    await processTrace({
      framework: "test",
      event: "tool_call",
      tool: longTool,
    });

    expect(appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "t".repeat(200),
      }),
    );
  });

  it("truncates result at 2000 chars", async () => {
    const longResult = "r".repeat(3000);
    await processTrace({
      framework: "test",
      event: "step",
      result: longResult,
    });

    expect(appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        traceResult: "r".repeat(2000),
      }),
    );
  });

  it("truncates tool args JSON at 2000 chars", async () => {
    const bigArgs: Record<string, string> = {};
    for (let i = 0; i < 50; i++) {
      bigArgs[`key_${i}`] = "x".repeat(100);
    }
    await processTrace({
      framework: "test",
      event: "tool_call",
      tool: "big_tool",
      args: bigArgs,
    });

    const call = (appendAuditEntry as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    expect(typeof call.toolArgs).toBe("string");
    expect((call.toolArgs as string).length).toBeLessThanOrEqual(2000);
  });

  it("limits args to 20 keys", async () => {
    const manyArgs: Record<string, string> = {};
    for (let i = 0; i < 30; i++) {
      manyArgs[`k${i}`] = `v${i}`;
    }
    await processTrace({
      framework: "test",
      event: "tool_call",
      tool: "many_args",
      args: manyArgs,
    });

    const call = (appendAuditEntry as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    const parsedArgs = JSON.parse(call.toolArgs as string) as Record<string, unknown>;
    expect(Object.keys(parsedArgs).length).toBeLessThanOrEqual(20);
  });

  // ── Optional fields ─────────────────────────────────────────────────────

  it("omits optional fields when not provided", async () => {
    await processTrace({
      framework: "test",
      event: "step",
    });

    expect(appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "TRACE",
        framework: "test",
        traceEvent: "step",
      }),
    );

    // Should NOT have tool fields
    const call = (appendAuditEntry as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    expect(call.toolName).toBeUndefined();
    expect(call.toolCallId).toBeUndefined();
    expect(call.toolArgs).toBeUndefined();
  });

  it("includes durationMs when provided", async () => {
    await processTrace({
      framework: "test",
      event: "node_exit",
      durationMs: 2500,
    });

    expect(appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        latencyMs: 2500,
      }),
    );
  });

  it("defaults latencyMs to 0 when durationMs not provided", async () => {
    await processTrace({
      framework: "test",
      event: "step",
    });

    expect(appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        latencyMs: 0,
      }),
    );
  });
});
