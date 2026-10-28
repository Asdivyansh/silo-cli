import { describe, it, expect } from "vitest";
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

// We test the internal logic by re-implementing a minimal version
// since the audit module uses homedir() for the log path. For unit tests
// we test the pure functions and verify JSONL serialisation.

import {
  type AuditEntry,
  matchQuery,
  matchStatusCode,
  matchLatency,
} from "../../src/audit/audit.js";

// ---------------------------------------------------------------------------
// JSONL serialisation / deserialisation
// ---------------------------------------------------------------------------

describe("AuditEntry serialisation", () => {
  it("round-trips an entry through JSON", () => {
    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      sessionId: "test-session-123",
      method: "POST",
      host: "llm.gateway",
      url: "http://llm.gateway/v1/chat/completions",
      category: "llm",
      verdict: "allow",
      statusCode: 200,
      latencyMs: 142,
      model: "gpt-4o",
    };

    const json = JSON.stringify(entry);
    const parsed = JSON.parse(json) as AuditEntry;

    expect(parsed.sessionId).toBe("test-session-123");
    expect(parsed.category).toBe("llm");
    expect(parsed.model).toBe("gpt-4o");
  });

  it("serialises entries without optional fields", () => {
    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      sessionId: "test-session-456",
      method: "GET",
      host: "pypi.org",
      url: "http://pypi.org/simple/requests/",
      category: "egress",
      verdict: "allow",
      statusCode: 200,
      latencyMs: 89,
    };

    const json = JSON.stringify(entry);
    const parsed = JSON.parse(json) as AuditEntry;

    expect(parsed.model).toBeUndefined();
    expect(parsed.framework).toBeUndefined();
  });

  it("serialises blocked entries", () => {
    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      sessionId: "test-session-789",
      method: "POST",
      host: "evil.example.com",
      url: "http://evil.example.com/exfiltrate",
      category: "blocked",
      verdict: "deny",
      statusCode: 403,
      latencyMs: 2,
    };

    const json = JSON.stringify(entry);
    const parsed = JSON.parse(json) as AuditEntry;

    expect(parsed.verdict).toBe("deny");
    expect(parsed.category).toBe("blocked");
    expect(parsed.statusCode).toBe(403);
  });

  it("serialises tool_call entries with tool-specific fields", () => {
    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      sessionId: "test-session-tc",
      method: "TOOL_CALL",
      host: "llm.gateway",
      url: "/v1/chat/completions",
      category: "tool_call",
      verdict: "allow",
      statusCode: 200,
      latencyMs: 0,
      toolName: "read_file",
      toolCallId: "call_abc123",
      toolArgs: '{"path":"/workspace/index.ts"}',
      framework: "crewai",
    };

    const json = JSON.stringify(entry);
    const parsed = JSON.parse(json) as AuditEntry;

    expect(parsed.category).toBe("tool_call");
    expect(parsed.toolName).toBe("read_file");
    expect(parsed.toolCallId).toBe("call_abc123");
    expect(parsed.framework).toBe("crewai");
  });

  it("serialises trace entries with agent and event fields", () => {
    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      sessionId: "test-session-tr",
      method: "TRACE",
      host: "framework",
      url: "crewai/Researcher/agent_start",
      category: "trace",
      verdict: "allow",
      statusCode: 0,
      latencyMs: 0,
      framework: "crewai",
      agent: "Researcher",
      traceEvent: "agent_start",
    };

    const json = JSON.stringify(entry);
    const parsed = JSON.parse(json) as AuditEntry;

    expect(parsed.category).toBe("trace");
    expect(parsed.agent).toBe("Researcher");
    expect(parsed.traceEvent).toBe("agent_start");
    expect(parsed.framework).toBe("crewai");
  });
});

// ---------------------------------------------------------------------------
// JSONL multi-line parsing
// ---------------------------------------------------------------------------

describe("JSONL parsing", () => {
  it("parses multiple entries from JSONL text", () => {
    const entries: AuditEntry[] = [
      {
        timestamp: "2026-01-01T00:00:00.000Z",
        sessionId: "s1",
        method: "POST",
        host: "llm.gateway",
        url: "/v1/chat/completions",
        category: "llm",
        verdict: "allow",
        statusCode: 200,
        latencyMs: 100,
      },
      {
        timestamp: "2026-01-01T00:01:00.000Z",
        sessionId: "s1",
        method: "GET",
        host: "pypi.org",
        url: "http://pypi.org/",
        category: "egress",
        verdict: "allow",
        statusCode: 200,
        latencyMs: 50,
      },
      {
        timestamp: "2026-01-01T00:02:00.000Z",
        sessionId: "s1",
        method: "POST",
        host: "evil.com",
        url: "http://evil.com/",
        category: "blocked",
        verdict: "deny",
        statusCode: 403,
        latencyMs: 1,
      },
    ];

    const jsonl = entries.map((e) => JSON.stringify(e)).join("\n");
    const lines = jsonl.split("\n").filter(Boolean);
    const parsed = lines.map((l) => JSON.parse(l) as AuditEntry);

    expect(parsed).toHaveLength(3);
    expect(parsed[0]?.category).toBe("llm");
    expect(parsed[1]?.category).toBe("egress");
    expect(parsed[2]?.category).toBe("blocked");
  });

  it("skips malformed JSONL lines gracefully", () => {
    const jsonl =
      '{"timestamp":"2026-01-01","sessionId":"s1","method":"GET","host":"x","url":"x","category":"egress","verdict":"allow","statusCode":200,"latencyMs":1}\n' +
      "{ invalid json }\n" +
      '{"timestamp":"2026-01-02","sessionId":"s1","method":"POST","host":"y","url":"y","category":"llm","verdict":"allow","statusCode":200,"latencyMs":2}';

    const lines = jsonl.split("\n").filter(Boolean);
    const parsed: AuditEntry[] = [];
    for (const line of lines) {
      try {
        parsed.push(JSON.parse(line) as AuditEntry);
      } catch {
        // skip
      }
    }

    expect(parsed).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Filtering logic
// ---------------------------------------------------------------------------

describe("audit entry filtering", () => {
  const entries: AuditEntry[] = [
    {
      timestamp: "2026-04-10T10:00:00.000Z",
      sessionId: "session-a",
      method: "POST",
      host: "llm.gateway",
      url: "/v1/chat/completions",
      category: "llm",
      verdict: "allow",
      statusCode: 200,
      latencyMs: 100,
      model: "gpt-4o",
    },
    {
      timestamp: "2026-04-10T11:00:00.000Z",
      sessionId: "session-a",
      method: "GET",
      host: "pypi.org",
      url: "http://pypi.org/",
      category: "egress",
      verdict: "allow",
      statusCode: 200,
      latencyMs: 50,
    },
    {
      timestamp: "2026-04-10T12:00:00.000Z",
      sessionId: "session-b",
      method: "POST",
      host: "evil.com",
      url: "http://evil.com/",
      category: "blocked",
      verdict: "deny",
      statusCode: 403,
      latencyMs: 1,
    },
    {
      timestamp: "2026-04-10T13:00:00.000Z",
      sessionId: "session-a",
      method: "TRACE",
      host: "framework",
      url: "crewai/Researcher/agent_start",
      category: "trace",
      verdict: "allow",
      statusCode: 0,
      latencyMs: 0,
      framework: "crewai",
      agent: "Researcher",
      traceEvent: "agent_start",
    },
  ];

  it("filters by category", () => {
    const llm = entries.filter((e) => e.category === "llm");
    expect(llm).toHaveLength(1);
    expect(llm[0]?.host).toBe("llm.gateway");
  });

  it("filters by verdict", () => {
    const denied = entries.filter((e) => e.verdict === "deny");
    expect(denied).toHaveLength(1);
    expect(denied[0]?.host).toBe("evil.com");
  });

  it("filters by sessionId", () => {
    const sessionA = entries.filter((e) => e.sessionId === "session-a");
    expect(sessionA).toHaveLength(3);
  });

  it("filters by since date", () => {
    const since = new Date("2026-04-10T11:30:00.000Z");
    const recent = entries.filter(
      (e) => new Date(e.timestamp).getTime() >= since.getTime(),
    );
    expect(recent).toHaveLength(2);
    expect(recent[0]?.host).toBe("evil.com");
  });

  it("applies tail (last N)", () => {
    const tail2 = entries.slice(-2);
    expect(tail2).toHaveLength(2);
    expect(tail2[0]?.host).toBe("evil.com");
    expect(tail2[1]?.host).toBe("framework");
  });

  it("filters by framework", () => {
    const crewai = entries.filter((e) => e.framework === "crewai");
    expect(crewai).toHaveLength(1);
    expect(crewai[0]?.agent).toBe("Researcher");
  });

  it("filters by agent", () => {
    const researcher = entries.filter((e) => e.agent === "Researcher");
    expect(researcher).toHaveLength(1);
    expect(researcher[0]?.traceEvent).toBe("agent_start");
  });

  it("filters trace category", () => {
    const traces = entries.filter((e) => e.category === "trace");
    expect(traces).toHaveLength(1);
    expect(traces[0]?.traceEvent).toBe("agent_start");
  });
});

describe("Advanced query matchers", () => {
  const sampleEntry: AuditEntry = {
    timestamp: "2026-04-10T10:00:00.000Z",
    sessionId: "sess-1",
    method: "POST",
    host: "api.github.com",
    url: "https://api.github.com/repos/silo/issues",
    category: "egress",
    verdict: "allow",
    statusCode: 201,
    latencyMs: 345,
    toolName: "create_issue",
    toolArgs: '{"title": "bug report"}',
  };

  describe("matchQuery", () => {
    it("matches search term case-insensitively in URL and host", () => {
      expect(matchQuery(sampleEntry, "github")).toBe(true);
      expect(matchQuery(sampleEntry, "GITHUB")).toBe(true);
      expect(matchQuery(sampleEntry, "issues")).toBe(true);
    });

    it("matches search term in tool fields", () => {
      expect(matchQuery(sampleEntry, "create_issue")).toBe(true);
      expect(matchQuery(sampleEntry, "bug report")).toBe(true);
    });

    it("returns false for non-matching terms", () => {
      expect(matchQuery(sampleEntry, "slack")).toBe(false);
    });
  });

  describe("matchStatusCode", () => {
    it("matches exact status codes", () => {
      expect(matchStatusCode(201, "201")).toBe(true);
      expect(matchStatusCode(201, "200")).toBe(false);
    });

    it("matches status code wildcards (xx)", () => {
      expect(matchStatusCode(201, "2xx")).toBe(true);
      expect(matchStatusCode(201, "2XX")).toBe(true);
      expect(matchStatusCode(403, "4xx")).toBe(true);
      expect(matchStatusCode(201, "3xx")).toBe(false);
    });

    it("matches status code ranges", () => {
      expect(matchStatusCode(201, "200-299")).toBe(true);
      expect(matchStatusCode(201, "200 - 250")).toBe(true);
      expect(matchStatusCode(301, "200-299")).toBe(false);
    });
  });

  describe("matchLatency", () => {
    it("matches latency exact values", () => {
      expect(matchLatency(345, "345")).toBe(true);
      expect(matchLatency(345, "300")).toBe(false);
    });

    it("matches latency with '+' suffix", () => {
      expect(matchLatency(345, "300+")).toBe(true);
      expect(matchLatency(345, "400+")).toBe(false);
    });

    it("matches latency with '>' and '<' prefix", () => {
      expect(matchLatency(345, ">300")).toBe(true);
      expect(matchLatency(345, ">400")).toBe(false);
      expect(matchLatency(345, "<400")).toBe(true);
      expect(matchLatency(345, "<300")).toBe(false);
    });

    it("matches latency ranges", () => {
      expect(matchLatency(345, "300-400")).toBe(true);
      expect(matchLatency(345, "100-200")).toBe(false);
    });
  });
});
