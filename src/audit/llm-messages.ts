export interface ExtractedLlmMessage {
  index: number;
  role: string;
  contentType: string;
  preview: string;
  chars: number;
  name?: string;
}

const DEFAULT_PREVIEW_CHARS = 240;

export function auditPreviewCharLimit(): number {
  const parsed = parseInt(process.env.SILO_LOG_PREVIEW_CHARS ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_PREVIEW_CHARS;
  return parsed;
}

export function extractLlmMessages(
  body: string,
  previewChars = auditPreviewCharLimit(),
): ExtractedLlmMessage[] {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return [];
  }

  if (!json || typeof json !== "object") return [];
  const obj = json as Record<string, unknown>;
  const messages = Array.isArray(obj.messages) ? obj.messages : [];
  const results: ExtractedLlmMessage[] = [];

  if (obj.system !== undefined) {
    const system = summariseContent(obj.system, previewChars);
    results.push({
      index: -1,
      role: "system",
      contentType: system.contentType,
      preview: system.preview,
      chars: system.chars,
    });
  }

  messages.forEach((message, idx) => {
    if (!message || typeof message !== "object") return;
    const msg = message as Record<string, unknown>;
    const role = typeof msg.role === "string" ? msg.role : "unknown";
    const name = typeof msg.name === "string" ? msg.name : undefined;
    const summary = summariseContent(msg.content, previewChars);

    results.push({
      index: idx,
      role,
      contentType: summary.contentType,
      preview: summary.preview,
      chars: summary.chars,
      ...(name ? { name } : {}),
    });
  });

  return results;
}

export function extractErrorPreview(
  body: string,
  previewChars = auditPreviewCharLimit(),
): string | undefined {
  if (!body.trim()) return undefined;

  try {
    const json = JSON.parse(body) as Record<string, unknown>;
    const error = json.error;
    if (error && typeof error === "object") {
      const err = error as Record<string, unknown>;
      const parts = [
        typeof err.type === "string" ? err.type : undefined,
        typeof err.code === "string" ? err.code : undefined,
        typeof err.message === "string" ? err.message : undefined,
      ].filter(Boolean);
      if (parts.length > 0) {
        return truncate(redact(parts.join(": ")), previewChars);
      }
    }

    for (const key of ["message", "detail", "error_description"]) {
      const value = json[key];
      if (typeof value === "string") {
        return truncate(redact(value), previewChars);
      }
    }
  } catch {
    // Fall through to plain text preview.
  }

  return truncate(redact(body.replace(/\s+/g, " ").trim()), previewChars);
}

function summariseContent(
  content: unknown,
  previewChars: number,
): { contentType: string; preview: string; chars: number } {
  const contentType = classifyContent(content);
  const text = contentToText(content);
  return {
    contentType,
    preview: truncate(redact(text.replace(/\s+/g, " ").trim()), previewChars),
    chars: text.length,
  };
}

function classifyContent(content: unknown): string {
  if (typeof content === "string") return "text";
  if (Array.isArray(content)) return "parts";
  if (content === null || content === undefined) return "empty";
  return typeof content;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";

  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === "string") {
        parts.push(item);
        continue;
      }
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      if (typeof obj.text === "string") parts.push(obj.text);
      else if (typeof obj.content === "string") parts.push(obj.content);
      else if (typeof obj.type === "string") parts.push(`[${obj.type}]`);
    }
    return parts.join(" ");
  }

  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function redact(value: string): string {
  return value
    .replace(/\bsk-ant-[A-Za-z0-9_-]+/g, "sk-ant-[redacted]")
    .replace(/\bsk-proj-[A-Za-z0-9_-]+/g, "sk-proj-[redacted]")
    .replace(/\bsk-(?!ant-|proj-)[A-Za-z0-9_-]+/g, "sk-[redacted]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]+/g, "xox[redacted]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]+/g, "github_pat_[redacted]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]+/g, "gh[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");
}

function truncate(value: string, max: number): string {
  if (max === 0) return "";
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
}
