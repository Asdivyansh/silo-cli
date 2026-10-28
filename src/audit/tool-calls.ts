/**
 * Tool Call Extraction
 *
 * Parses LLM API response bodies (OpenAI and Anthropic formats) to
 * extract individual tool calls. Used by the proxy to create per-tool
 * audit entries that show exactly what each agent is doing.
 *
 * Supports:
 *   - OpenAI: choices[].message.tool_calls[]
 *   - Anthropic: content[].type === "tool_use"
 *   - SSE streaming: scans data: lines for tool call chunks
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtractedToolCall {
  /** Tool call ID from the provider */
  id: string;
  /** Tool/function name */
  name: string;
  /** Raw arguments JSON string */
  arguments: string;
  /** Parsed arguments (best-effort, null if invalid JSON) */
  parsedArgs: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract tool calls from an LLM response body.
 * Returns an empty array if no tool calls are found.
 */
export function extractToolCalls(
  body: string,
  provider: "openai" | "anthropic" | "local",
): ExtractedToolCall[] {
  try {
    const json = JSON.parse(body);
    return extractFromJson(json, provider);
  } catch {
    // May be SSE — try that
    return extractFromSSE(body, provider);
  }
}

// ---------------------------------------------------------------------------
// OpenAI format
// ---------------------------------------------------------------------------

function extractOpenAIToolCalls(json: Record<string, unknown>): ExtractedToolCall[] {
  const choices = json.choices as Array<{
    message?: {
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }> | undefined;

  if (!choices || !Array.isArray(choices)) return [];

  const results: ExtractedToolCall[] = [];

  for (const choice of choices) {
    const toolCalls = choice.message?.tool_calls;
    if (!toolCalls || !Array.isArray(toolCalls)) continue;

    for (const tc of toolCalls) {
      if (tc.type !== "function" || !tc.function) continue;

      const argsStr = tc.function.arguments ?? "{}";
      let parsedArgs: Record<string, unknown> | null = null;
      try {
        parsedArgs = JSON.parse(argsStr);
      } catch {
        // Invalid JSON args — store as-is
      }

      results.push({
        id: tc.id ?? `tc_${Date.now()}`,
        name: tc.function.name ?? "unknown",
        arguments: argsStr,
        parsedArgs,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Anthropic format
// ---------------------------------------------------------------------------

function extractAnthropicToolCalls(json: Record<string, unknown>): ExtractedToolCall[] {
  const content = json.content as Array<{
    type?: string;
    id?: string;
    name?: string;
    input?: unknown;
  }> | undefined;

  if (!content || !Array.isArray(content)) return [];

  const results: ExtractedToolCall[] = [];

  for (const block of content) {
    if (block.type !== "tool_use") continue;

    const argsStr = JSON.stringify(block.input ?? {});
    let parsedArgs: Record<string, unknown> | null = null;
    try {
      parsedArgs = typeof block.input === "object" && block.input !== null
        ? (block.input as Record<string, unknown>)
        : null;
    } catch {
      // pass
    }

    results.push({
      id: block.id ?? `tc_${Date.now()}`,
      name: block.name ?? "unknown",
      arguments: argsStr,
      parsedArgs,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// JSON dispatch
// ---------------------------------------------------------------------------

function extractFromJson(
  json: Record<string, unknown>,
  provider: string,
): ExtractedToolCall[] {
  if (provider === "anthropic") {
    return extractAnthropicToolCalls(json);
  }
  // OpenAI and local both use the OpenAI format
  return extractOpenAIToolCalls(json);
}

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

function extractFromSSE(
  body: string,
  provider: "openai" | "anthropic" | "local",
): ExtractedToolCall[] {
  const dataLines = body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6).trim())
    .filter((line) => line !== "[DONE]");

  // For streaming, tool calls are split across multiple chunks.
  // We need to reassemble them.

  if (provider === "anthropic") {
    return reassembleAnthropicStream(dataLines);
  }

  return reassembleOpenAIStream(dataLines);
}

/**
 * Reassemble OpenAI streaming tool calls.
 * OpenAI sends tool calls across delta chunks:
 *   { delta: { tool_calls: [{ index, id, function: { name, arguments } }] } }
 * Arguments arrive in pieces across multiple chunks.
 */
function reassembleOpenAIStream(dataLines: string[]): ExtractedToolCall[] {
  const toolCallMap = new Map<number, { id: string; name: string; args: string }>();

  for (const line of dataLines) {
    try {
      const json = JSON.parse(line) as {
        choices?: Array<{
          delta?: {
            tool_calls?: Array<{
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
        }>;
      };

      const delta = json.choices?.[0]?.delta;
      if (!delta?.tool_calls) continue;

      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        const existing = toolCallMap.get(idx);

        if (existing) {
          // Append arguments chunk
          if (tc.function?.arguments) {
            existing.args += tc.function.arguments;
          }
        } else {
          toolCallMap.set(idx, {
            id: tc.id ?? `tc_stream_${idx}`,
            name: tc.function?.name ?? "unknown",
            args: tc.function?.arguments ?? "",
          });
        }
      }
    } catch {
      continue;
    }
  }

  return Array.from(toolCallMap.values()).map((tc) => {
    let parsedArgs: Record<string, unknown> | null = null;
    try {
      parsedArgs = JSON.parse(tc.args);
    } catch {
      // pass
    }
    return {
      id: tc.id,
      name: tc.name,
      arguments: tc.args,
      parsedArgs,
    };
  });
}

/**
 * Reassemble Anthropic streaming tool calls.
 * Anthropic sends content_block_start + content_block_delta events.
 */
function reassembleAnthropicStream(dataLines: string[]): ExtractedToolCall[] {
  const toolCalls: Array<{ id: string; name: string; args: string }> = [];
  let currentTool: { id: string; name: string; args: string } | null = null;

  for (const line of dataLines) {
    try {
      const json = JSON.parse(line) as {
        type?: string;
        content_block?: { type?: string; id?: string; name?: string };
        delta?: { type?: string; partial_json?: string };
      };

      if (json.type === "content_block_start" && json.content_block?.type === "tool_use") {
        currentTool = {
          id: json.content_block.id ?? `tc_stream_${toolCalls.length}`,
          name: json.content_block.name ?? "unknown",
          args: "",
        };
      }

      if (json.type === "content_block_delta" && json.delta?.type === "input_json_delta" && currentTool) {
        currentTool.args += json.delta.partial_json ?? "";
      }

      if (json.type === "content_block_stop" && currentTool) {
        toolCalls.push(currentTool);
        currentTool = null;
      }
    } catch {
      continue;
    }
  }

  // Handle case where stream ends without content_block_stop
  if (currentTool) {
    toolCalls.push(currentTool);
  }

  return toolCalls.map((tc) => {
    let parsedArgs: Record<string, unknown> | null = null;
    try {
      parsedArgs = JSON.parse(tc.args);
    } catch {
      // pass
    }
    return {
      id: tc.id,
      name: tc.name,
      arguments: tc.args,
      parsedArgs,
    };
  });
}

// ---------------------------------------------------------------------------
// Token Usage Extraction
// ---------------------------------------------------------------------------

export interface ExtractedTokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/**
 * Extract token usage from an LLM response body (JSON or SSE stream).
 */
export function extractTokenUsage(
  body: string,
  provider: "openai" | "anthropic" | "local",
): ExtractedTokenUsage {
  try {
    const json = JSON.parse(body);
    return extractUsageFromJson(json, provider);
  } catch {
    return extractUsageFromSSE(body, provider);
  }
}

function extractUsageFromJson(json: any, provider: string): ExtractedTokenUsage {
  if (json && typeof json === "object" && json.usage) {
    const u = json.usage;
    if (provider === "anthropic") {
      const prompt = typeof u.input_tokens === "number" ? u.input_tokens : undefined;
      const completion = typeof u.output_tokens === "number" ? u.output_tokens : undefined;
      return {
        promptTokens: prompt,
        completionTokens: completion,
        totalTokens: (prompt !== undefined || completion !== undefined)
          ? ((prompt ?? 0) + (completion ?? 0))
          : undefined,
      };
    } else {
      const prompt = typeof u.prompt_tokens === "number" ? u.prompt_tokens : undefined;
      const completion = typeof u.completion_tokens === "number" ? u.completion_tokens : undefined;
      const total = typeof u.total_tokens === "number" ? u.total_tokens : undefined;
      return {
        promptTokens: prompt,
        completionTokens: completion,
        totalTokens: total ?? ((prompt !== undefined || completion !== undefined)
          ? ((prompt ?? 0) + (completion ?? 0))
          : undefined),
      };
    }
  }
  return {};
}

function extractUsageFromSSE(body: string, provider: "openai" | "anthropic" | "local"): ExtractedTokenUsage {
  const dataLines = body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6).trim())
    .filter((line) => line !== "[DONE]");

  // For Anthropic, stream parts carry input_tokens in message_start and output_tokens in message_delta/stop
  if (provider === "anthropic") {
    let prompt: number | undefined;
    let completion: number | undefined;
    for (const line of dataLines) {
      try {
        const json = JSON.parse(line);
        if (json && typeof json === "object") {
          if (json.type === "message_start" && typeof json.message?.usage?.input_tokens === "number") {
            prompt = json.message.usage.input_tokens;
          }
          if (json.type === "message_delta" && typeof json.usage?.output_tokens === "number") {
            completion = json.usage.output_tokens;
          }
          if (json.type === "message_stop" && typeof json.message?.usage?.output_tokens === "number") {
            completion = json.message.usage.output_tokens;
          }
        }
      } catch {
        // pass
      }
    }
    if (prompt !== undefined || completion !== undefined) {
      return {
        promptTokens: prompt,
        completionTokens: completion,
        totalTokens: (prompt !== undefined || completion !== undefined)
          ? ((prompt ?? 0) + (completion ?? 0))
          : undefined,
      };
    }
  }

  // For OpenAI/local formats, look backwards for a chunk containing "usage"
  for (let i = dataLines.length - 1; i >= 0; i--) {
    try {
      const json = JSON.parse(dataLines[i]!);
      if (json && typeof json === "object" && json.usage) {
        return extractUsageFromJson(json, provider);
      }
    } catch {
      // pass
    }
  }

  return {};
}

