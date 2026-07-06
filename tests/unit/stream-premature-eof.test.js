import { describe, it, expect, vi } from "vitest";
import { createNormalizedStream } from "../../open-sse/streaming/createNormalizedStream.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const encoder = new TextEncoder();

function makeMockIterator(chunks) {
  return {
    parseChunk() { return chunks; },
    flush() { return null; },
  };
}

async function readStream(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
  } catch (e) {
    return { output: out, error: e };
  }
  return { output: out, error: null };
}

function makeStream(chunks, options = {}) {
  const source = new ReadableStream({
    start(c) {
      c.enqueue(encoder.encode("data: init\n\n"));
      c.close();
    },
  });

  const normalized = createNormalizedStream({
    responseIterator: makeMockIterator(chunks),
    mode: "passthrough",
    sourceFormat: FORMATS.OPENAI,
    provider: "nvidia",
    model: "kimi-k2.6",
    connectionId: "test",
    body: { max_tokens: 64000 },
    apiKey: null,
    ...options,
  });

  return source.pipeThrough(normalized);
}

describe("createNormalizedStream premature EOF handling", () => {
  it("does NOT synthesize finish_reason: 'stop' when upstream only sends reasoning", async () => {
    const stream = makeStream([
      { id: "1", choices: [{ index: 0, delta: { reasoning_content: "thinking..." } }] },
    ]);
    const { output } = await readStream(stream);

    expect(output).toContain('"reasoning_content":"thinking..."');
    expect(output).toContain("data: [DONE]");
    expect(output).not.toContain('"finish_reason":"stop"');
  });

  it("forwards an upstream finish_reason: 'length' unchanged", async () => {
    const stream = makeStream([
      { id: "1", choices: [{ index: 0, delta: { reasoning_content: "thinking..." } }] },
      { id: "2", choices: [{ index: 0, delta: {}, finish_reason: "length" }] },
    ]);
    const { output } = await readStream(stream);

    expect(output).toContain('"finish_reason":"length"');
    expect(output).not.toContain('"finish_reason":"stop"');
  });

  it("normalizes delta.reasoning to delta.reasoning_content", async () => {
    const stream = makeStream([
      { id: "1", choices: [{ index: 0, delta: { reasoning: "thinking..." } }] },
    ]);
    const { output } = await readStream(stream);

    expect(output).toContain('"reasoning_content":"thinking..."');
    expect(output).not.toContain('"reasoning":"thinking..."');
    expect(output).not.toContain('"finish_reason":"stop"');
  });

  it("normalizes delta.reasoning_text to delta.reasoning_content", async () => {
    const stream = makeStream([
      { id: "1", choices: [{ index: 0, delta: { reasoning_text: "thinking..." } }] },
    ]);
    const { output } = await readStream(stream);

    expect(output).toContain('"reasoning_content":"thinking..."');
    expect(output).not.toContain('"reasoning_text":"thinking..."');
    expect(output).not.toContain('"finish_reason":"stop"');
  });

  it("keeps existing finish_reason: 'stop' from upstream", async () => {
    const stream = makeStream([
      { id: "1", choices: [{ index: 0, delta: { content: "hello" } }] },
      { id: "2", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]);
    const { output } = await readStream(stream);

    expect(output).toContain('"finish_reason":"stop"');
  });
});
