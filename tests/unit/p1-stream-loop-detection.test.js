import { describe, it, expect, vi } from "vitest";
import { createNormalizedStream } from "../../open-sse/streaming/createNormalizedStream.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { STREAM_LOOP_THRESHOLD } from "../../open-sse/config/runtimeConfig.js";

const encoder = new TextEncoder();

function makeMockIterator(content = "A") {
  return {
    parseChunk() {
      return [{ id: "test", object: "chat.completion.chunk", created: 1, choices: [{ index: 0, delta: { content } }] }];
    },
    flush() { return null; },
  };
}

function makeStream(content = "A") {
  return createNormalizedStream({
    responseIterator: makeMockIterator(content),
    mode: "passthrough",
    sourceFormat: FORMATS.OPENAI,
    provider: "test",
    model: "test-model",
    connectionId: "test-conn",
    body: {},
    apiKey: null,
  });
}

describe("P1 #7 — Stream loop detection", () => {
  it("aborts when identical content repeats STREAM_LOOP_THRESHOLD times", async () => {
    const total = STREAM_LOOP_THRESHOLD + 5;
    const source = new ReadableStream({
      start(c) {
        for (let i = 0; i < total; i++) c.enqueue(encoder.encode("data: test\n\n"));
        c.close();
      },
    });

    const stream = makeStream("X");
    const piped = source.pipeThrough(stream);
    const reader = piped.getReader();

    let errorCaught = null;
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch (e) {
      errorCaught = e;
    }
    expect(errorCaught).toBeTruthy();
    expect(errorCaught.message).toContain("loop detected");
  });

  it("does NOT abort when content varies (counter resets)", async () => {
    let callCount = 0;
    const contents = ["A", "B", "A", "B", "A", "B"];
    const iterator = {
      parseChunk() {
        const content = contents[callCount % contents.length];
        callCount++;
        return [{ id: "test", object: "chat.completion.chunk", created: 1, choices: [{ index: 0, delta: { content } }] }];
      },
      flush() { return null; },
    };

    const stream = createNormalizedStream({
      responseIterator: iterator,
      mode: "passthrough",
      sourceFormat: FORMATS.OPENAI,
      provider: "test",
      model: "test-model",
      connectionId: "test-conn",
      body: {},
      apiKey: null,
    });

    const total = STREAM_LOOP_THRESHOLD + 10;
    const source = new ReadableStream({
      start(c) {
        for (let i = 0; i < total; i++) c.enqueue(encoder.encode("data: test\n\n"));
        c.close();
      },
    });

    const piped = source.pipeThrough(stream);
    const reader = piped.getReader();

    let chunkCount = 0;
    let errorCaught = null;
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
        chunkCount++;
      }
    } catch (e) {
      errorCaught = e;
    }
    expect(errorCaught).toBeNull();
    expect(chunkCount).toBeGreaterThan(0);
  });

  it("does NOT abort for usage-only chunks (no content delta)", async () => {
    let callCount = 0;
    const iterator = {
      parseChunk() {
        callCount++;
        if (callCount % 3 === 0) {
          return [{ id: "test", object: "chat.completion.chunk", created: 1, choices: [{ index: 0, delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 5 } }];
        }
        return [{ id: "test", object: "chat.completion.chunk", created: 1, choices: [{ index: 0, delta: { content: "A" } }] }];
      },
      flush() { return null; },
    };

    const stream = createNormalizedStream({
      responseIterator: iterator,
      mode: "passthrough",
      sourceFormat: FORMATS.OPENAI,
      provider: "test",
      model: "test-model",
      connectionId: "test-conn",
      body: {},
      apiKey: null,
    });

    // Write enough chunks to exceed threshold for "A" content (2/3 of total)
    const total = Math.ceil(STREAM_LOOP_THRESHOLD * 1.6) + 10;
    const source = new ReadableStream({
      start(c) {
        for (let i = 0; i < total; i++) c.enqueue(encoder.encode("data: test\n\n"));
        c.close();
      },
    });

    const piped = source.pipeThrough(stream);
    const reader = piped.getReader();

    let errorCaught = null;
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch (e) {
      errorCaught = e;
    }
    // Should abort because "A" content repeats > threshold times
    expect(errorCaught).toBeTruthy();
    expect(errorCaught.message).toContain("loop detected");
  });

  it("does NOT abort below threshold", async () => {
    const total = STREAM_LOOP_THRESHOLD - 1;
    const source = new ReadableStream({
      start(c) {
        for (let i = 0; i < total; i++) c.enqueue(encoder.encode("data: test\n\n"));
        c.close();
      },
    });

    const stream = makeStream("Z");
    const piped = source.pipeThrough(stream);
    const reader = piped.getReader();

    let errorCaught = null;
    let chunkCount = 0;
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
        chunkCount++;
      }
    } catch (e) {
      errorCaught = e;
    }
    expect(errorCaught).toBeNull();
    expect(chunkCount).toBeGreaterThan(0);
  });
});
