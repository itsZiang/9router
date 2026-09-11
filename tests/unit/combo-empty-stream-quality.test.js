import { describe, it, expect } from "vitest";
import { validateResponseQuality } from "../../open-sse/services/combo/validateQuality.js";

const encoder = new TextEncoder();
const log = { warn() {}, info() {} };

function sseResponse(lines) {
  const stream = new ReadableStream({
    start(c) {
      for (const line of lines) c.enqueue(encoder.encode(line));
      c.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const chunk = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

function jsonResponse(obj, contentType = "application/json") {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "content-type": contentType },
  });
}

describe("validateResponseQuality streaming empty-close failover", () => {
  it("marks a zero-byte stream (immediate close) as invalid for combo failover", async () => {
    const res = sseResponse([]);
    const quality = await validateResponseQuality(res, true, log, undefined);

    expect(quality.valid).toBe(false);
    expect(quality.reason).toContain("no content and no finish_reason");
  });

  it("marks a [DONE]-only stream as invalid for combo failover", async () => {
    const res = sseResponse(["data: [DONE]\n\n"]);
    const quality = await validateResponseQuality(res, true, log, undefined);

    expect(quality.valid).toBe(false);
    expect(quality.reason).toContain("no content and no finish_reason");
  });

  it("passes a finish_reason-only stream (terminated but empty)", async () => {
    const res = sseResponse([
      chunk({ id: "1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
      "data: [DONE]\n\n",
    ]);
    const quality = await validateResponseQuality(res, true, log, undefined);

    expect(quality.valid).toBe(true);
  });

  it("passes a stream with content (existing behavior)", async () => {
    const res = sseResponse([
      chunk({ id: "1", choices: [{ index: 0, delta: { content: "hi" } }] }),
      chunk({ id: "2", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
      "data: [DONE]\n\n",
    ]);
    const quality = await validateResponseQuality(res, true, log, undefined);

    expect(quality.valid).toBe(true);
    expect(quality.clonedResponse).toBeDefined();
  });

  it("still fails a complete Claude lifecycle with zero content blocks", async () => {
    const res = sseResponse([
      'event: message_start\ndata: {"type":"message_start"}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"content_filter"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]);
    const quality = await validateResponseQuality(res, true, log, undefined);

    expect(quality.valid).toBe(false);
  });
});

describe("validateResponseQuality non-SSE bodies for streaming requests", () => {
  it("marks a JSON error wearing a 200 as invalid (fails over)", async () => {
    const res = jsonResponse({ error: { message: "quota exceeded", code: 429 } });
    const quality = await validateResponseQuality(res, true, log, undefined);

    expect(quality.valid).toBe(false);
    expect(quality.reason).toContain("upstream error in 200 body");
  });

  it("marks an empty non-SSE body as invalid", async () => {
    const res = new Response("", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const quality = await validateResponseQuality(res, true, log, undefined);

    expect(quality.valid).toBe(false);
    expect(quality.reason).toContain("empty body");
  });

  it("marks a null body as invalid for streaming requests", async () => {
    const res = new Response(null, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    expect(res.body).toBeNull();
    const quality = await validateResponseQuality(res, true, log, undefined);

    expect(quality.valid).toBe(false);
    expect(quality.reason).toContain("no body");
  });

  it("still passes a complete JSON payload with content (downstream converts JSON to SSE)", async () => {
    const res = jsonResponse({
      id: "chatcmpl-x",
      object: "chat.completion",
      created: 1,
      model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    const quality = await validateResponseQuality(res, true, log, undefined);

    expect(quality.valid).toBe(true);
  });

  it("marks JSON without streamable content as invalid", async () => {
    const res = jsonResponse({ choices: [{ index: 0, message: { role: "assistant", content: null }, finish_reason: "stop" }] });
    const quality = await validateResponseQuality(res, true, log, undefined);

    expect(quality.valid).toBe(false);
  });

  it("keeps passing the same JSON payload for non-streaming requests (no behavior change)", async () => {
    const res = jsonResponse({
      id: "chatcmpl-x",
      object: "chat.completion",
      created: 1,
      model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    const quality = await validateResponseQuality(res, false, log, undefined);

    expect(quality.valid).toBe(true);
  });
});
