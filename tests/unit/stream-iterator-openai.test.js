import { describe, it, expect } from "vitest";
import { OpenAIResponseIterator } from "../../open-sse/streaming/OpenAIResponseIterator.js";

function chunksFrom(iterator, raw) {
  return iterator.parseChunk(new TextEncoder().encode(raw));
}

describe("OpenAIResponseIterator", () => {
  it("parses a single data line into a normalized chunk", () => {
    const iter = new OpenAIResponseIterator({ model: "gpt-4o" });
    const raw = 'data: {"id":"cmpl-1","choices":[{"delta":{"content":"hello"}}]}\n\n';
    const items = chunksFrom(iter, raw);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("cmpl-1");
    expect(items[0].object).toBe("chat.completion.chunk");
    expect(items[0].created).toBeGreaterThan(0);
    expect(items[0].choices[0].delta.content).toBe("hello");
  });

  it("returns { done: true } for [DONE]", () => {
    const iter = new OpenAIResponseIterator({});
    const raw = 'data: [DONE]\n\n';
    const items = chunksFrom(iter, raw);
    expect(items).toHaveLength(1);
    expect(items[0].done).toBe(true);
    expect(iter.done).toBe(true);
  });

  it("aggregates multiple data lines", () => {
    const iter = new OpenAIResponseIterator({});
    const raw = 'data: {"id":"1"}\n\ndata: {"id":"2"}\n\n';
    const items = chunksFrom(iter, raw);
    expect(items[0].id).toBe("1");
    expect(items[1].id).toBe("2");
  });

  it("ignores SSE event / id / comment lines", () => {
    const iter = new OpenAIResponseIterator({});
    const raw = 'event: message\nid: 123\n:comment\ndata: {"id":"3"}\n\n';
    const items = chunksFrom(iter, raw);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("3");
  });

  it("handles partial chunks across parseChunk calls", () => {
    const iter = new OpenAIResponseIterator({});
    const part1 = 'data: {"id":"4","choices":[{"delta":{"';
    const part2 = 'content":"ok"}}]}\n\n';
    expect(chunksFrom(iter, part1)).toBeNull();
    const items = chunksFrom(iter, part2);
    expect(items).toHaveLength(1);
    expect(items[0].choices[0].delta.content).toBe("ok");
  });

  it("flush yields trailing data without final newline", () => {
    const iter = new OpenAIResponseIterator({});
    iter.parseChunk(new TextEncoder().encode('data: {"id":"5"}'));
    const flushed = iter.flush();
    expect(flushed).toHaveLength(1);
    expect(flushed[0].id).toBe("5");
  });

  it("normalizes missing fields", () => {
    const iter = new OpenAIResponseIterator({ model: "m" });
    const raw = 'data: {"choices":[{"delta":{"content":"x"}}]}\n\n';
    const items = chunksFrom(iter, raw);
    expect(items[0].object).toBe("chat.completion.chunk");
    expect(items[0].model).toBe("m");
    expect(items[0].created).toBeGreaterThan(0);
  });
});
