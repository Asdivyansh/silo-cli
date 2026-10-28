/**
 * `silo run` — Agent Task Runner
 *
 * Orchestrates an LLM-powered agent loop on the host side:
 *   1. Sends the task to the LLM via the local inference proxy (audited + policy-checked)
 *   2. If the LLM produces tool calls, executes them inside the sandbox via `docker exec`
 *   3. Feeds tool results back to the LLM
 *   4. Loops until the LLM produces a final text response or --max-turns is reached
 *
 * Available tools: `execute_command`, `read_file`, `write_file`
 * All tool execution happens inside the sandboxed container.
 *
 * LLM calls are routed through the inference proxy at 127.0.0.1:{port}
 * so they appear in the unified audit log and benefit from credential injection.
 */
import chalk from "chalk";
import { execa } from "execa";
import {
  request as makeHttpRequest,
  type IncomingMessage,
} from "node:http";
import { URL } from "node:url";
import { readConfig } from "../config/manager.js";
import { log, printBanner } from "../utils/logger.js";
import { assertDockerAvailable, isContainerRunning } from "../utils/system.js";
import { ensureProxyRunning } from "../utils/health.js";
import type { LLMConfig } from "../config/schema.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RunOptions {
  maxTurns: number;
  name?: string;
  policy?: string;
  stream: boolean;
}

interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}


// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "execute_command",
      description:
        "Run a shell command inside the sandboxed agent container. " +
        "Working directory is /workspace. Returns stdout, stderr, and exit code.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute (e.g. 'ls -la', 'python3 script.py')",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description:
        "Read the contents of a file inside the sandbox. " +
        "Paths are relative to /workspace unless absolute. Returns the file content as a string.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file to read (e.g. 'main.py', '/workspace/data/output.csv')",
          },
          max_lines: {
            type: "number",
            description: "Maximum number of lines to read. Defaults to 200. Use for large files.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "write_file",
      description:
        "Write content to a file inside the sandbox. Creates parent directories if needed. " +
        "Paths are relative to /workspace unless absolute.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file to write (e.g. 'script.py', 'output/results.json')",
          },
          content: {
            type: "string",
            description: "The content to write to the file",
          },
        },
        required: ["path", "content"],
      },
    },
  },
];

// Anthropic uses a different tool format
function toAnthropicTools() {
  return TOOLS.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(task: string): string {
  return [
    "You are an AI agent running inside a secure sandbox container.",
    "Your working directory is /workspace which is mounted from the host.",
    "",
    "You have access to these tools:",
    "  - `execute_command` — run any shell command",
    "  - `read_file` — read file contents (faster than cat for large files)",
    "  - `write_file` — write/create files (faster than echo/heredoc)",
    "",
    "Use them to accomplish the task below. You can call multiple tools.",
    "When the task is complete, provide a summary of what you did.",
    "",
    "Available programs in the sandbox: python3, pip, curl, git, jq, and standard Unix utilities.",
    "",
    `TASK: ${task}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runAgent(task: string, opts: RunOptions): Promise<void> {
  printBanner();

  const config = readConfig();
  if (!config) {
    log.error("No configuration found. Run `silo onboard` first.");
    process.exit(1);
  }

  // Guard against NaN from bad CLI input
  const maxTurns = Number.isFinite(opts.maxTurns) && opts.maxTurns > 0 ? opts.maxTurns : 10;

  await assertDockerAvailable();

  const containerName = opts.name ? `silo-${opts.name}` : config.sandbox.containerName;

  if (!(await isContainerRunning(containerName))) {
    log.error(`Sandbox "${containerName}" is not running.`);
    log.info(`Start it first with ${chalk.cyan("silo start")}.`);
    process.exit(1);
  }

  // Ensure proxy is alive for auditing
  await ensureProxyRunning(config);

  const { startPromptListener } = await import("../utils/prompt-listener.js");
  const promptListener = startPromptListener(config.proxy.port);

  try {
    log.info(`Agent:  ${chalk.cyan(containerName)}`);
    log.info(`Model:  ${chalk.cyan(config.llm.model)}`);
    log.info(`Task:   ${chalk.dim(task)}`);
    log.blank();

    const messages: Message[] = [
      { role: "system", content: buildSystemPrompt(task) },
      { role: "user", content: task },
    ];

    for (let turn = 1; turn <= maxTurns; turn++) {
      log.info(chalk.dim(`── Turn ${turn}/${maxTurns} ──`));

      // Call the LLM via the inference proxy
      const response = await callLlm(messages, config.llm, config.proxy.port, opts.stream);

      if (!response) {
        log.error("LLM returned an empty response.");
        break;
      }

      messages.push(response);

      // Check for tool calls
      if (response.tool_calls && response.tool_calls.length > 0) {
        for (const toolCall of response.tool_calls) {
          const { name, arguments: argsStr } = toolCall.function;

          let args: Record<string, unknown>;
          try {
            args = JSON.parse(argsStr);
          } catch {
            log.error(`Invalid tool call arguments: ${argsStr}`);
            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: "Error: Invalid JSON arguments.",
            });
            continue;
          }

          // Dispatch to the correct tool handler
          switch (name) {
            case "execute_command": {
              const command = (args.command as string) ?? "";
              if (!command) {
                messages.push({
                  role: "tool",
                  tool_call_id: toolCall.id,
                  content: "Error: 'command' parameter is required and cannot be empty.",
                });
                continue;
              }

              console.log(`\n${chalk.yellow("⚡")} ${chalk.bold("execute_command")}: ${chalk.cyan(command)}`);
              const result = await executeInContainer(containerName, command);

              if (result.stdout) console.log(chalk.dim(result.stdout.slice(0, 2000)));
              if (result.stderr) console.log(chalk.red(result.stderr.slice(0, 1000)));
              console.log(chalk.dim(`exit code: ${result.exitCode}\n`));

              messages.push({
                role: "tool",
                tool_call_id: toolCall.id,
                content: JSON.stringify({
                  stdout: result.stdout.slice(0, 8000),
                  stderr: result.stderr.slice(0, 2000),
                  exitCode: result.exitCode,
                }),
              });
              break;
            }

            case "read_file": {
              const filePath = (args.path as string) ?? "";
              let maxLines = 200;
              if (args.max_lines !== undefined) {
                const parsed = Number(args.max_lines);
                if (Number.isInteger(parsed) && parsed > 0) {
                  maxLines = parsed;
                }
              }
              if (!filePath) {
                messages.push({
                  role: "tool",
                  tool_call_id: toolCall.id,
                  content: "Error: 'path' parameter is required.",
                });
                continue;
              }

              console.log(`\n${chalk.blue("📄")} ${chalk.bold("read_file")}: ${chalk.cyan(filePath)}`);
              const readResult = await executeArgsInContainer(containerName, [
                "head",
                "-n",
                String(maxLines),
                filePath,
              ]);

              if (readResult.exitCode !== 0) {
                console.log(chalk.red(readResult.stderr.slice(0, 500)));
                messages.push({
                  role: "tool",
                  tool_call_id: toolCall.id,
                  content: `Error reading file: ${readResult.stderr.slice(0, 1000)}`,
                });
              } else {
                console.log(chalk.dim(`(${readResult.stdout.split("\n").length} lines)\n`));
                messages.push({
                  role: "tool",
                  tool_call_id: toolCall.id,
                  content: readResult.stdout.slice(0, 16000),
                });
              }
              break;
            }

            case "write_file": {
              const filePath = (args.path as string) ?? "";
              const content = (args.content as string) ?? "";
              if (!filePath) {
                messages.push({
                  role: "tool",
                  tool_call_id: toolCall.id,
                  content: "Error: 'path' parameter is required.",
                });
                continue;
              }

              console.log(`\n${chalk.green("✏️")} ${chalk.bold("write_file")}: ${chalk.cyan(filePath)}`);
              // Create parent dirs and write via tee
              const dir = filePath.includes("/")
                ? filePath.slice(0, filePath.lastIndexOf("/"))
                : null;
              if (dir) {
                const mkdirResult = await executeArgsInContainer(containerName, ["mkdir", "-p", dir]);
                if (mkdirResult.exitCode !== 0) {
                  console.log(chalk.red(mkdirResult.stderr.slice(0, 500)));
                  messages.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    content: `Error creating directory: ${mkdirResult.stderr.slice(0, 1000)}`,
                  });
                  continue;
                }
              }

              const writeResult = await executeArgsInContainer(
                containerName,
                ["tee", filePath],
                { input: content, stdout: "ignore" }
              );

              if (writeResult.exitCode !== 0) {
                console.log(chalk.red(writeResult.stderr.slice(0, 500)));
                messages.push({
                  role: "tool",
                  tool_call_id: toolCall.id,
                  content: `Error writing file: ${writeResult.stderr.slice(0, 1000)}`,
                });
              } else {
                const lines = content.split("\n").length;
                console.log(chalk.dim(`(${lines} lines, ${content.length} bytes)\n`));
                messages.push({
                  role: "tool",
                  tool_call_id: toolCall.id,
                  content: JSON.stringify({ success: true, path: filePath, bytes: content.length }),
                });
              }
              break;
            }

            default: {
              log.warn(`Unknown tool call: ${name}`);
              messages.push({
                role: "tool",
                tool_call_id: toolCall.id,
                content: `Error: Unknown tool "${name}". Available tools: execute_command, read_file, write_file.`,
              });
            }
          }
        }
      } else {
        // No tool calls — final response
        if (response.content) {
          console.log(`\n${chalk.green("✔")} ${chalk.bold("Agent response:")}\n`);
          console.log(response.content);
        }
        log.blank();
        log.success(`Agent completed in ${turn} turn(s).`);
        return;
      }
    }

    log.blank();
    log.warn(`Agent reached max turns (${maxTurns}). Stopping.`);
  } finally {
    promptListener.stop();
  }
}

// LLM API call — routed through the local inference proxy
// ---------------------------------------------------------------------------
// All LLM calls from `silo run` go through the proxy at 127.0.0.1:{port}
// so they are audited, policy-checked, and have credentials injected.
// ---------------------------------------------------------------------------

async function callLlm(
  messages: Message[],
  llm: LLMConfig,
  proxyPort: number,
  stream: boolean,
): Promise<Message | null> {
  if (llm.provider === "anthropic") {
    return callAnthropicViaProxy(messages, llm, proxyPort, stream);
  }

  // OpenAI and local providers use the same format
  return callOpenAIViaProxy(messages, llm, proxyPort, stream);
}

async function callOpenAIViaProxy(
  messages: Message[],
  llm: LLMConfig,
  proxyPort: number,
  stream: boolean,
): Promise<Message | null> {
  const body = JSON.stringify({
    model: llm.model,
    messages,
    tools: TOOLS,
    tool_choice: "auto",
    ...(stream ? { stream: true } : {}),
  });

  // Route through local proxy — it handles auth injection and auditing
  const proxyUrl = `http://127.0.0.1:${proxyPort}/v1/chat/completions`;
  const parsed = new URL(proxyUrl);

  return new Promise((resolve) => {
    const req = makeHttpRequest(
      {
        hostname: parsed.hostname,
        port: parsed.port || 80,
        path: parsed.pathname + parsed.search,
        method: "POST",
        timeout: 120_000, // 2 minute timeout for LLM responses
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          // x-silo-framework header helps the proxy tag audit entries
          "x-silo-runner": "silo-run",
        },
      },
      (res: IncomingMessage) => {
        if (!stream) {
          let responseBody = "";
          res.on("data", (chunk: Buffer) => {
            responseBody += chunk.toString();
          });
          res.on("end", () => {
            try {
              const json = JSON.parse(responseBody) as {
                choices?: Array<{ message?: Message }>;
                error?: { message: string };
                usage?: { prompt_tokens?: number; completion_tokens?: number };
              };

              if (json.error) {
                log.error(`LLM API error: ${json.error.message}`);
                resolve(null);
                return;
              }

              const msg = json.choices?.[0]?.message;
              if (!msg) {
                resolve(null);
                return;
              }

              resolve(msg);
            } catch (err) {
              log.error(`Failed to parse LLM response: ${String(err)}`);
              log.debug(`Response body: ${responseBody.slice(0, 500)}`);
              resolve(null);
            }
          });
          res.on("error", (err) => {
            log.error(`LLM response stream error: ${String(err)}`);
            resolve(null);
          });
        } else {
          let responseBody = "";
          let content = "";
          const tool_calls: any[] = [];
          let buffer = "";
          let apiErrorMessage: string | null = null;

          res.on("data", (chunk: Buffer) => {
            responseBody += chunk.toString();
            buffer += chunk.toString("utf8");

            let boundary = buffer.indexOf("\n");
            while (boundary !== -1) {
              const line = buffer.slice(0, boundary).trim();
              buffer = buffer.slice(boundary + 1);
              boundary = buffer.indexOf("\n");

              if (line.startsWith("data: ")) {
                const dataStr = line.slice(6).trim();
                if (dataStr === "[DONE]") continue;
                try {
                  const parsedJson = JSON.parse(dataStr);

                  if (parsedJson.error?.message) {
                    apiErrorMessage = parsedJson.error.message;
                  }

                  // Extract content delta
                  const deltaContent = parsedJson.choices?.[0]?.delta?.content;
                  if (deltaContent) {
                    process.stdout.write(deltaContent);
                    content += deltaContent;
                  }

                  // Extract tool calls delta
                  const deltaToolCalls = parsedJson.choices?.[0]?.delta?.tool_calls;
                  if (deltaToolCalls) {
                    for (const tcDelta of deltaToolCalls) {
                      const idx = tcDelta.index ?? 0;
                      if (!tool_calls[idx]) {
                        tool_calls[idx] = {
                          id: tcDelta.id || "",
                          type: "function",
                          function: { name: "", arguments: "" }
                        };
                      }
                      if (tcDelta.id) tool_calls[idx].id = tcDelta.id;
                      if (tcDelta.function?.name) tool_calls[idx].function.name += tcDelta.function.name;
                      if (tcDelta.function?.arguments) tool_calls[idx].function.arguments += tcDelta.function.arguments;
                    }
                  }
                } catch {
                  // ignore malformed JSON chunk
                }
              }
            }
          });

          res.on("end", () => {
            if (content) {
              console.log();
            }

            const statusCode = res.statusCode ?? 200;
            if (statusCode >= 400 || apiErrorMessage) {
              // Error responses arrive as plain JSON, not SSE — parse the raw body
              if (!apiErrorMessage) {
                try {
                  const json = JSON.parse(responseBody) as { error?: { message?: string } };
                  apiErrorMessage = json.error?.message ?? null;
                } catch {
                  // body was not JSON — fall through to the raw preview
                }
              }
              log.error(
                `LLM API error (HTTP ${statusCode}): ${apiErrorMessage ?? responseBody.slice(0, 500)}`,
              );
              resolve(null);
              return;
            }

            const cleanToolCalls = tool_calls.filter(Boolean);
            if (!content && cleanToolCalls.length === 0) {
              resolve(null);
              return;
            }

            const msg: Message = {
              role: "assistant",
              content: content || null,
            };
            if (cleanToolCalls.length > 0) {
              msg.tool_calls = cleanToolCalls;
            }

            resolve(msg);
          });

          res.on("error", (err) => {
            log.error(`LLM response stream error: ${String(err)}`);
            resolve(null);
          });
        }
      },
    );

    req.on("error", (err) => {
      log.error(`LLM request failed: ${String(err)}`);
      log.info(`Is the proxy running? Try: ${chalk.cyan("silo status")}`);
      resolve(null);
    });

    req.on("timeout", () => {
      req.destroy();
      log.error("LLM request timed out after 120s.");
      resolve(null);
    });

    req.write(body);
    req.end();
  });
}

async function callAnthropicViaProxy(
  messages: Message[],
  llm: LLMConfig,
  proxyPort: number,
  stream: boolean,
): Promise<Message | null> {
  // Extract system message and convert to Anthropic format
  const systemMsg = messages.find((m) => m.role === "system")?.content ?? "";
  const nonSystemMessages = messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      if (m.role === "tool") {
        return {
          role: "user" as const,
          content: [
            {
              type: "tool_result" as const,
              tool_use_id: m.tool_call_id,
              content: m.content ?? "",
            },
          ],
        };
      }
      if (m.role === "assistant" && m.tool_calls) {
        const contentList: any[] = [];
        if (m.content) {
          contentList.push({
            type: "text" as const,
            text: m.content,
          });
        }
        contentList.push(
          ...m.tool_calls.map((tc) => ({
            type: "tool_use" as const,
            id: tc.id,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments),
          }))
        );
        return {
          role: "assistant" as const,
          content: contentList,
        };
      }
      return { role: m.role, content: m.content ?? "" };
    });

  const body = JSON.stringify({
    model: llm.model,
    max_tokens: 4096,
    system: systemMsg,
    messages: nonSystemMessages,
    tools: toAnthropicTools(),
    ...(stream ? { stream: true } : {}),
  });

  // Route through local proxy — it handles auth injection and auditing
  const proxyUrl = `http://127.0.0.1:${proxyPort}/v1/messages`;
  const parsed = new URL(proxyUrl);

  return new Promise((resolve) => {
    const req = makeHttpRequest(
      {
        hostname: parsed.hostname,
        port: parsed.port || 80,
        path: parsed.pathname + parsed.search,
        method: "POST",
        timeout: 120_000, // 2 minute timeout
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "x-silo-runner": "silo-run",
        },
      },
      (res: IncomingMessage) => {
        if (!stream) {
          let responseBody = "";
          res.on("data", (chunk: Buffer) => {
            responseBody += chunk.toString();
          });
          res.on("end", () => {
            try {
              const json = JSON.parse(responseBody) as {
                content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
                error?: { message: string };
                stop_reason?: string;
                usage?: { input_tokens?: number; output_tokens?: number };
              };

              if (json.error) {
                log.error(`Anthropic API error: ${json.error.message}`);
                resolve(null);
                return;
              }

              // Convert Anthropic response to OpenAI-compatible format
              const contentBlocks = json.content ?? [];
              const textBlocks = contentBlocks.filter((b) => b.type === "text");
              const toolBlocks = contentBlocks.filter((b) => b.type === "tool_use");

              const message: Message = {
                role: "assistant",
                content: textBlocks.map((b) => b.text).join("\n") || null,
              };

              if (toolBlocks.length > 0) {
                message.tool_calls = toolBlocks.map((b) => ({
                  id: b.id!,
                  type: "function" as const,
                  function: {
                    name: b.name!,
                    arguments: JSON.stringify(b.input),
                  },
                }));
              }

              resolve(message);
            } catch (err) {
              log.error(`Failed to parse Anthropic response: ${String(err)}`);
              resolve(null);
            }
          });
          res.on("error", (err) => {
            log.error(`Anthropic response stream error: ${String(err)}`);
            resolve(null);
          });
        } else {
          let responseBody = "";
          let content = "";
          const tool_calls: any[] = [];
          let buffer = "";
          let apiErrorMessage: string | null = null;

          res.on("data", (chunk: Buffer) => {
            responseBody += chunk.toString();
            buffer += chunk.toString("utf8");

            let boundary = buffer.indexOf("\n");
            while (boundary !== -1) {
              const line = buffer.slice(0, boundary).trim();
              buffer = buffer.slice(boundary + 1);
              boundary = buffer.indexOf("\n");

              if (line.startsWith("data: ")) {
                const dataStr = line.slice(6).trim();
                try {
                  const parsedJson = JSON.parse(dataStr);

                  if (parsedJson.type === "error" && parsedJson.error?.message) {
                    apiErrorMessage = parsedJson.error.message;
                  }

                  if (parsedJson.type === "content_block_delta" && parsedJson.delta?.type === "text_delta") {
                    const text = parsedJson.delta.text;
                    if (text) {
                      process.stdout.write(text);
                      content += text;
                    }
                  }

                  if (parsedJson.type === "content_block_start" && parsedJson.content_block?.type === "tool_use") {
                    const idx = parsedJson.index ?? 0;
                    tool_calls[idx] = {
                      id: parsedJson.content_block.id || "",
                      type: "function",
                      function: { name: parsedJson.content_block.name || "", arguments: "" }
                    };
                  }

                  if (parsedJson.type === "content_block_delta" && parsedJson.delta?.type === "input_json_delta") {
                    const idx = parsedJson.index ?? 0;
                    const partialJson = parsedJson.delta.partial_json;
                    if (partialJson && tool_calls[idx]) {
                      tool_calls[idx].function.arguments += partialJson;
                    }
                  }
                } catch {
                  // ignore malformed JSON chunk
                }
              }
            }
          });

          res.on("end", () => {
            if (content) {
              console.log();
            }

            const statusCode = res.statusCode ?? 200;
            if (statusCode >= 400 || apiErrorMessage) {
              // Error responses arrive as plain JSON, not SSE — parse the raw body
              if (!apiErrorMessage) {
                try {
                  const json = JSON.parse(responseBody) as { error?: { message?: string } };
                  apiErrorMessage = json.error?.message ?? null;
                } catch {
                  // body was not JSON — fall through to the raw preview
                }
              }
              log.error(
                `Anthropic API error (HTTP ${statusCode}): ${apiErrorMessage ?? responseBody.slice(0, 500)}`,
              );
              resolve(null);
              return;
            }

            const cleanToolCalls = tool_calls.filter(Boolean);
            if (!content && cleanToolCalls.length === 0) {
              resolve(null);
              return;
            }

            const msg: Message = {
              role: "assistant",
              content: content || null,
            };
            if (cleanToolCalls.length > 0) {
              msg.tool_calls = cleanToolCalls;
            }

            resolve(msg);
          });

          res.on("error", (err) => {
            log.error(`Anthropic response stream error: ${String(err)}`);
            resolve(null);
          });
        }
      },
    );

    req.on("error", (err) => {
      log.error(`Anthropic request failed: ${String(err)}`);
      log.info(`Is the proxy running? Try: ${chalk.cyan("silo status")}`);
      resolve(null);
    });

    req.on("timeout", () => {
      req.destroy();
      log.error("Anthropic request timed out after 120s.");
      resolve(null);
    });

    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Container command execution
// ---------------------------------------------------------------------------

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function executeInContainer(
  containerName: string,
  command: string,
): Promise<ExecResult> {
  try {
    const result = await execa(
      "docker",
      ["exec", "--workdir", "/workspace", containerName, "/bin/sh", "-c", command],
      {
        timeout: 120_000, // 120s max per command (some installs take time)
        reject: false,    // Don't throw on non-zero exit
      },
    );

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  } catch (err) {
    return {
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      exitCode: 1,
    };
  }
}

async function executeArgsInContainer(
  containerName: string,
  args: string[],
  options?: { input?: string; stdout?: "pipe" | "ignore" | "inherit" }
): Promise<ExecResult> {
  try {
    const result = await execa(
      "docker",
      ["exec", "-i", "--workdir", "/workspace", containerName, ...args],
      {
        timeout: 120_000, // 120s max per command
        reject: false,    // Don't throw on non-zero exit
        input: options?.input,
        stdout: options?.stdout ?? "pipe",
      },
    );

    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  } catch (err) {
    return {
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      exitCode: 1,
    };
  }
}
