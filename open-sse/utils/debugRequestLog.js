import { createWriteStream } from "fs";
import { join } from "path";
import { homedir } from "os";

const LOG_FILE = join(homedir(), "9router-debug.log");
const stream = createWriteStream(LOG_FILE, { flags: "a" });

function now() {
  const d = new Date();
  return d.toISOString();
}

const MAX_MESSAGE_TEXT_LEN = 200;

function truncateText(value) {
  if (typeof value !== "string") return value;
  if (value.length <= MAX_MESSAGE_TEXT_LEN) return value;
  return value.slice(0, MAX_MESSAGE_TEXT_LEN) + `...[truncated:${value.length}chars]`;
}

function sanitizeMessage(message) {
  if (!message || typeof message !== "object") return message;
  const sanitized = { ...message };
  if (typeof sanitized.content === "string") {
    sanitized.content = truncateText(sanitized.content);
  } else if (Array.isArray(sanitized.content)) {
    sanitized.content = sanitized.content.map(part => {
      if (!part || typeof part !== "object") return part;
      if (typeof part.text === "string") {
        return { ...part, text: truncateText(part.text) };
      }
      return part;
    });
  }
  if (typeof sanitized.system === "string") {
    sanitized.system = truncateText(sanitized.system);
  }
  return sanitized;
}

function sanitizeBody(body) {
  if (!body || typeof body !== "object") return body;
  const sanitized = { ...body };
  if (Array.isArray(sanitized.messages)) {
    const total = sanitized.messages.length;
    const keepFirst = 2;
    const keepLast = 2;
    if (total > keepFirst + keepLast) {
      const first = sanitized.messages.slice(0, keepFirst).map(sanitizeMessage);
      const last = sanitized.messages.slice(-keepLast).map(sanitizeMessage);
      sanitized.messages = [
        ...first,
        { note: `...${total - keepFirst - keepLast} messages omitted...` },
        ...last,
      ];
    } else {
      sanitized.messages = sanitized.messages.map(sanitizeMessage);
    }
  }
  return sanitized;
}

export function logDebugRequest({ provider, model, finalBody, label = "REQUEST" }) {
  const entry = {
    t: now(),
    label,
    provider,
    model,
    finalBody: sanitizeBody(finalBody),
  };
  stream.write(JSON.stringify(entry) + "\n");
}

export function logDebugResponseChunk({ provider, model, chunk }) {
  const entry = {
    t: now(),
    label: "RESPONSE_CHUNK",
    provider,
    model,
    chunk,
  };
  stream.write(JSON.stringify(entry) + "\n");
}

export function logDebugLine(text) {
  stream.write(`[${now()}] ${text}\n`);
}
