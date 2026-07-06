import { isVisionModelId } from "../../stubs/shared/constants/visionModels";
import { createCompressionStats } from "./stats";
function trimTrailingHorizontalWhitespace(line) {
  let end = line.length;
  while (end > 0) {
    const code = line.charCodeAt(end - 1);
    if (code !== 32 && code !== 9) break;
    end--;
  }
  return end === line.length ? line : line.slice(0, end);
}
function collapseNewlineRuns(content) {
  let normalized = "";
  let newlineRun = 0;
  for (const char of content) {
    if (char === "\n") {
      newlineRun++;
      if (newlineRun <= 2) {
        normalized += char;
      }
      continue;
    }
    newlineRun = 0;
    normalized += char;
  }
  return normalized;
}
function normalizeMessageWhitespace(content) {
  return collapseNewlineRuns(content).split("\n").map(trimTrailingHorizontalWhitespace).join("\n");
}

// Vision detection is centralized in `@/shared/constants/visionModels` (#4072) so
// the lite image-strip gate, the /v1/models listing, and the routing fallback can
// never disagree. The shared list keeps the #3328 MiniMax M3 carve-out and the
// pixtral/llava/qwen-vl/glm-4v/kimi-vl/mistral-medium-3 families this gate used to
// miss (stripping their images and blinding real vision models).
function modelSupportsVision(model) {
  return isVisionModelId(model);
}
export function collapseWhitespace(body, options = {}) {
  if (!body.messages) return {
    body,
    applied: false
  };
  let applied = false;
  const messages = body.messages.map(msg => {
    if (options.preserveSystemPrompt === true && msg.role === "system") return msg;
    if (typeof msg.content !== "string") return msg;
    const normalized = normalizeMessageWhitespace(msg.content);
    if (normalized !== msg.content) applied = true;
    return {
      ...msg,
      content: normalized
    };
  });
  return {
    body: {
      ...body,
      messages
    },
    applied
  };
}
export function dedupSystemPrompt(body, options = {}) {
  if (!body.messages) return {
    body,
    applied: false
  };
  if (options.preserveSystemPrompt === true) return {
    body,
    applied: false
  };
  const seen = new Set();
  let applied = false;
  const messages = body.messages.filter(msg => {
    if (msg.role !== "system" || typeof msg.content !== "string") return true;
    const key = msg.content.trim().slice(0, 200);
    if (seen.has(key)) {
      applied = true;
      return false;
    }
    seen.add(key);
    return true;
  });
  return {
    body: {
      ...body,
      messages
    },
    applied
  };
}
export function compressToolResults(body) {
  if (!body.messages) return {
    body,
    applied: false
  };
  const MAX_TOOL_LENGTH = 2000;
  let applied = false;
  const messages = body.messages.map(msg => {
    if (msg.role !== "tool" || typeof msg.content !== "string") return msg;
    if (msg.content.length <= MAX_TOOL_LENGTH) return msg;
    applied = true;
    return {
      ...msg,
      content: msg.content.slice(0, MAX_TOOL_LENGTH) + "\n...[truncated]"
    };
  });
  return {
    body: {
      ...body,
      messages
    },
    applied
  };
}
export function removeRedundantContent(body, options = {}) {
  if (!body.messages) return {
    body,
    applied: false
  };
  let applied = false;
  const messages = [];
  for (let i = 0; i < body.messages.length; i++) {
    const msg = body.messages[i];
    if (options.preserveSystemPrompt === true && msg.role === "system") {
      messages.push(msg);
      continue;
    }
    const contentStr = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    if (i > 0 && body.messages[i - 1].role === msg.role && typeof body.messages[i - 1].content === "string" && body.messages[i - 1].content === contentStr) {
      applied = true;
      continue;
    }
    messages.push(msg);
  }
  return {
    body: {
      ...body,
      messages
    },
    applied
  };
}
export function replaceImageUrls(body, options) {
  if (!body.messages) return {
    body,
    applied: false
  };
  const supportsVision = typeof options === "object" && options !== null ? options.supportsVision : typeof options === "string" ? modelSupportsVision(options) : undefined;
  if (supportsVision !== false) return {
    body,
    applied: false
  };
  let applied = false;
  const messages = body.messages.map(msg => {
    if (!Array.isArray(msg.content)) return msg;
    const newContent = msg.content.map(part => {
      if (typeof part === "object" && part !== null && part.type === "image_url" && typeof part.image_url === "object" && part.image_url?.url) {
        const url = String(part.image_url.url);
        if (url.startsWith("data:image/")) {
          applied = true;
          const format = url.slice(url.indexOf("/") + 1, url.indexOf(";")) || "unknown";
          return {
            type: "text",
            text: `[image: ${format}]`
          };
        }
      }
      return part;
    });
    return {
      ...msg,
      content: newContent
    };
  });
  return {
    body: {
      ...body,
      messages
    },
    applied
  };
}
export function applyLiteCompression(body, options) {
  const originalBody = body;
  let current = body;
  const techniquesApplied = [];
  const r1 = collapseWhitespace(current, options);
  current = r1.body;
  if (r1.applied) techniquesApplied.push("whitespace");
  const r2 = dedupSystemPrompt(current, options);
  current = r2.body;
  if (r2.applied) techniquesApplied.push("system-dedup");
  const r3 = compressToolResults(current);
  current = r3.body;
  if (r3.applied) techniquesApplied.push("tool-compress");
  const r4 = removeRedundantContent(current, options);
  current = r4.body;
  if (r4.applied) techniquesApplied.push("redundant-remove");
  const r5 = replaceImageUrls(current, options);
  current = r5.body;
  if (r5.applied) techniquesApplied.push("image-placeholder");
  const compressed = techniquesApplied.length > 0;
  const stats = compressed ? createCompressionStats(originalBody, current, "lite", techniquesApplied) : null;
  return {
    body: current,
    compressed,
    stats
  };
}