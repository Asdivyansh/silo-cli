import { afterEach, describe, expect, it } from "vitest";
import {
  auditPreviewCharLimit,
  extractErrorPreview,
  extractLlmMessages,
} from "../../src/audit/llm-messages.js";

const ellipsis = String.fromCharCode(8230);

describe("LLM message audit extraction", () => {
  const previousPreviewLimit = process.env.SILO_LOG_PREVIEW_CHARS;

  afterEach(() => {
    if (previousPreviewLimit === undefined) {
      delete process.env.SILO_LOG_PREVIEW_CHARS;
    } else {
      process.env.SILO_LOG_PREVIEW_CHARS = previousPreviewLimit;
    }
  });

  it("extracts top-level system content and each request message", () => {
    const body = JSON.stringify({
      system: "Use the repository conventions.",
      messages: [
        { role: "user", content: "Please inspect the project." },
        {
          role: "assistant",
          content: [
            { type: "text", text: "I will check the files." },
            { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
          ],
        },
        { role: "tool", name: "read_file", content: { path: "/workspace/package.json" } },
      ],
    });

    const messages = extractLlmMessages(body);

    expect(messages).toHaveLength(4);
    expect(messages[0]).toMatchObject({
      index: -1,
      role: "system",
      contentType: "text",
      preview: "Use the repository conventions.",
    });
    expect(messages[1]).toMatchObject({
      index: 0,
      role: "user",
      contentType: "text",
      preview: "Please inspect the project.",
    });
    expect(messages[2]).toMatchObject({
      index: 1,
      role: "assistant",
      contentType: "parts",
      preview: "I will check the files. [image_url]",
    });
    expect(messages[3]).toMatchObject({
      index: 2,
      role: "tool",
      contentType: "object",
      name: "read_file",
    });
    expect(messages[3]?.preview).toContain("/workspace/package.json");
  });

  it("returns an empty list for non-JSON request bodies", () => {
    expect(extractLlmMessages("not-json")).toEqual([]);
  });

  it("truncates previews without changing the original character count", () => {
    const body = JSON.stringify({
      messages: [{ role: "user", content: "abcdefghijklmnopqrstuvwxyz" }],
    });

    const [message] = extractLlmMessages(body, 10);

    expect(message?.chars).toBe(26);
    expect(message?.preview).toBe(`abcdefghi${ellipsis}`);
  });

  it("redacts common credential patterns from message previews", () => {
    const body = JSON.stringify({
      messages: [
        {
          role: "user",
          content: "Bearer abc123 sk-proj-secret github_pat_abc123 xoxb-123-456",
        },
      ],
    });

    const [message] = extractLlmMessages(body, 240);

    expect(message?.preview).toContain("Bearer [redacted]");
    expect(message?.preview).toContain("sk-proj-[redacted]");
    expect(message?.preview).toContain("github_pat_[redacted]");
    expect(message?.preview).toContain("xox[redacted]");
    expect(message?.preview).not.toContain("abc123");
  });

  it("honors SILO_LOG_PREVIEW_CHARS including zero", () => {
    process.env.SILO_LOG_PREVIEW_CHARS = "0";
    expect(auditPreviewCharLimit()).toBe(0);

    const [message] = extractLlmMessages(
      JSON.stringify({ messages: [{ role: "user", content: "hidden" }] }),
    );

    expect(message?.preview).toBe("");
  });
});

describe("LLM error preview extraction", () => {
  it("extracts and redacts structured provider errors", () => {
    const preview = extractErrorPreview(
      JSON.stringify({
        error: {
          type: "invalid_request_error",
          code: "bad_auth",
          message: "Bad key sk-ant-secret",
        },
      }),
      240,
    );

    expect(preview).toBe("invalid_request_error: bad_auth: Bad key sk-ant-[redacted]");
  });

  it("falls back to plain text error previews", () => {
    const preview = extractErrorPreview("upstream failed with Bearer abc123", 240);

    expect(preview).toBe("upstream failed with Bearer [redacted]");
  });
});
