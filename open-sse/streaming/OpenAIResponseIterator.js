import { BaseResponseIterator } from "./BaseResponseIterator.js";

function normalizeOpenAIChunk(parsed, model, provider) {
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.done) return { done: true };

  // Non-choice events (e.g. usage-only or ping) pass through untouched
  if (parsed.choices === undefined) return parsed;

  return {
    ...parsed,
    id: parsed.id || "",
    object: parsed.object || "chat.completion.chunk",
    created: parsed.created || Math.floor(Date.now() / 1000),
    model: parsed.model || model || "",
    choices: Array.isArray(parsed.choices)
      ? parsed.choices.map((c) => ({
          index: c.index ?? 0,
          delta: c.delta || {},
          finish_reason: c.finish_reason ?? null,
          logprobs: c.logprobs ?? null,
        }))
      : [],
    usage: parsed.usage ?? undefined,
  };
}

export class OpenAIResponseIterator extends BaseResponseIterator {
  _parseBuffer(isFlush = false) {
    const chunks = [];
    let idx;
    while ((idx = this._buffer.indexOf("\n")) >= 0) {
      const line = this._buffer.slice(0, idx);
      this._buffer = this._buffer.slice(idx + 1);
      const parsed = this._parseLine(line);
      if (parsed) chunks.push(parsed);
    }

    if (isFlush && this._buffer.trim()) {
      const parsed = this._parseLine(this._buffer);
      if (parsed) chunks.push(parsed);
      this._buffer = "";
    }

    return chunks.length ? chunks : null;
  }

  _parseLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return null;
    // Skip SSE metadata lines (id, event, comment)
    if (trimmed.startsWith("event:") || trimmed.startsWith("id:") || trimmed.startsWith(":")) {
      return null;
    }
    if (!trimmed.startsWith("data:")) return null;
    const data = trimmed.slice(5).trim();
    if (data === "[DONE]") {
      this.done = true;
      return { done: true };
    }
    try {
      const parsed = JSON.parse(data);
      return normalizeOpenAIChunk(parsed, this.model, this.provider);
    } catch {
      return null;
    }
  }
}

export default OpenAIResponseIterator;
