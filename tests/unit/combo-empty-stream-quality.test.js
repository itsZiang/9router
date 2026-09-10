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
