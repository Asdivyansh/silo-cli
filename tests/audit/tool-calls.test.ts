import { describe, it, expect } from "vitest";
import { extractToolCalls } from "../../src/audit/tool-calls.js";

// ---------------------------------------------------------------------------
// OpenAI non-streaming
// ---------------------------------------------------------------------------

describe("extractToolCalls — OpenAI format", () => {
  it("extracts a single tool call", () => {
    const body = JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_abc123",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: '{"path":"/workspace/main.ts"}',
                },
              },
            ],
          },
        },
      ],
    });

    const result = extractToolCalls(body, "openai");
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("call_abc123");
    expect(result[0]!.name).toBe("read_file");
    expect(result[0]!.parsedArgs).toEqual({ path: "/workspace/main.ts" });
  });

  it("extracts multiple tool calls from one response", () => {
    const body = JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "read_file", arguments: '{"path":"a.ts"}' },
              },
              {
                id: "call_2",
                type: "function",
                function: { name: "write_file", arguments: '{"path":"b.ts","content":"hi"}' },
              },
              {
                id: "call_3",
                type: "function",
                function: { name: "run_command", arguments: '{"cmd":"npm test"}' },
              },
            ],
          },
        },
      ],
    });

    const result = extractToolCalls(body, "openai");
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.name)).toEqual(["read_file", "write_file", "run_command"]);
  });

  it("returns empty array for pure text response (no tool calls)", () => {
    const body = JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: "Hello! How can I help you?",
          },
        },
      ],
    });

    const result = extractToolCalls(body, "openai");
    expect(result).toHaveLength(0);
  });

  it("handles missing arguments gracefully", () => {
    const body = JSON.stringify({
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: "call_no_args",
                type: "function",
                function: { name: "list_dir" },
              },
            ],
          },
        },
      ],
    });

    const result = extractToolCalls(body, "openai");
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("list_dir");
    expect(result[0]!.arguments).toBe("{}");
  });

  it("handles invalid JSON arguments", () => {
    const body = JSON.stringify({
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: "call_bad_args",
                type: "function",
                function: { name: "test", arguments: "not valid json" },
              },
            ],
          },
        },
      ],
    });

    const result = extractToolCalls(body, "openai");
    expect(result).toHaveLength(1);
    expect(result[0]!.parsedArgs).toBeNull();
    expect(result[0]!.arguments).toBe("not valid json");
  });

  it("also works for 'local' provider (same format)", () => {
    const body = JSON.stringify({
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: "call_local",
                type: "function",
                function: { name: "search", arguments: '{"q":"test"}' },
              },
            ],
          },
        },
      ],
    });

    const result = extractToolCalls(body, "local");
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("search");
  });
});

// ---------------------------------------------------------------------------
// Anthropic non-streaming
// ---------------------------------------------------------------------------

describe("extractToolCalls — Anthropic format", () => {
  it("extracts a single tool_use block", () => {
    const body = JSON.stringify({
      content: [
        { type: "text", text: "Let me read that file." },
        {
          type: "tool_use",
          id: "toolu_abc",
          name: "read_file",
          input: { path: "/workspace/main.py" },
        },
      ],
    });

    const result = extractToolCalls(body, "anthropic");
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("toolu_abc");
    expect(result[0]!.name).toBe("read_file");
    expect(result[0]!.parsedArgs).toEqual({ path: "/workspace/main.py" });
  });

  it("extracts multiple tool_use blocks", () => {
    const body = JSON.stringify({
      content: [
        { type: "text", text: "I'll do two things." },
        { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a.py" } },
        { type: "tool_use", id: "toolu_2", name: "write_file", input: { path: "b.py", content: "x" } },
      ],
    });

    const result = extractToolCalls(body, "anthropic");
    expect(result).toHaveLength(2);
    expect(result[0]!.name).toBe("read_file");
    expect(result[1]!.name).toBe("write_file");
  });

  it("returns empty array for text-only response", () => {
    const body = JSON.stringify({
      content: [{ type: "text", text: "Just a normal response." }],
    });

    const result = extractToolCalls(body, "anthropic");
    expect(result).toHaveLength(0);
  });

  it("handles tool_use with null input", () => {
    const body = JSON.stringify({
      content: [
        { type: "tool_use", id: "toolu_null", name: "noop", input: null },
      ],
    });

    const result = extractToolCalls(body, "anthropic");
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("noop");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("extractToolCalls — edge cases", () => {
  it("returns empty array for invalid JSON body", () => {
    const result = extractToolCalls("not json at all", "openai");
    expect(result).toHaveLength(0);
  });

  it("returns empty array for empty string", () => {
    const result = extractToolCalls("", "openai");
    expect(result).toHaveLength(0);
  });

  it("returns empty array for empty object", () => {
    const result = extractToolCalls("{}", "openai");
    expect(result).toHaveLength(0);
  });

  it("returns empty array for response with error", () => {
    const body = JSON.stringify({
      error: { message: "Rate limit exceeded" },
    });
    const result = extractToolCalls(body, "openai");
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// OpenAI SSE streaming
// ---------------------------------------------------------------------------

describe("extractToolCalls — OpenAI SSE streaming", () => {
  it("reassembles a streamed tool call from delta chunks", () => {
    // Simulate SSE stream with tool call split across chunks
    // The arguments are sent in pieces: {"path" + ":"/wor" + "kspace"} 
    const sseLines = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_stream1","function":{"name":"read_file","arguments":"{"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"path\\""}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"hello\\"}"}}]}}]}',
      "data: [DONE]",
    ].join("\n");

    const result = extractToolCalls(sseLines, "openai");
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("read_file");
    expect(result[0]!.parsedArgs).toEqual({ path: "hello" });
  });

  it("reassembles multiple streamed tool calls", () => {
    const sseLines = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"read_file","arguments":"{\\"path\\":\\"a.ts\\"}"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_b","function":{"name":"write_file","arguments":"{\\"path\\":\\"b.ts\\"}"}}]}}]}',
      "data: [DONE]",
    ].join("\n");

    const result = extractToolCalls(sseLines, "openai");
    expect(result).toHaveLength(2);
    expect(result[0]!.name).toBe("read_file");
    expect(result[1]!.name).toBe("write_file");
  });
});

// ---------------------------------------------------------------------------
// Token Usage Tests
// ---------------------------------------------------------------------------

import { extractTokenUsage } from "../../src/audit/tool-calls.js";

describe("extractTokenUsage", () => {
  it("extracts usage from OpenAI non-streaming JSON", () => {
    const body = JSON.stringify({
      choices: [],
      usage: {
        prompt_tokens: 120,
        completion_tokens: 80,
        total_tokens: 200,
      },
    });
    const result = extractTokenUsage(body, "openai");
    expect(result).toEqual({
      promptTokens: 120,
      completionTokens: 80,
      totalTokens: 200,
    });
  });

  it("extracts usage from Anthropic non-streaming JSON", () => {
    const body = JSON.stringify({
      content: [],
      usage: {
        input_tokens: 150,
        output_tokens: 50,
      },
    });
    const result = extractTokenUsage(body, "anthropic");
    expect(result).toEqual({
      promptTokens: 150,
      completionTokens: 50,
      totalTokens: 200,
    });
  });

  it("extracts usage from OpenAI SSE stream", () => {
    const sseLines = [
      'data: {"choices":[{"delta":{"content":"hello"}}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}',
      "data: [DONE]",
    ].join("\n");
    const result = extractTokenUsage(sseLines, "openai");
    expect(result).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
  });

  it("extracts usage from Anthropic SSE stream", () => {
    const sseLines = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":100}}}',
      'data: {"type":"content_block_start"}',
      'data: {"type":"message_delta","usage":{"output_tokens":40}}',
      'data: {"type":"message_stop"}',
    ].join("\n");
    const result = extractTokenUsage(sseLines, "anthropic");
    expect(result).toEqual({
      promptTokens: 100,
      completionTokens: 40,
      totalTokens: 140,
    });
  });
});
