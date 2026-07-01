import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

function makeSlowStream(firstChunkDelayMs) {
  return new ReadableStream({
    start(controller) {
      setTimeout(() => {
        if (firstChunkDelayMs < 0) {
          controller.close();
        } else {
          controller.enqueue(new TextEncoder().encode("data: ok\n\n"));
          controller.close();
        }
      }, firstChunkDelayMs);
    },
  });
}

describe("withFirstChunkTimeout helper", () => {
  let withFirstChunkTimeout;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../../open-sse/utils/proxyFetch.js");
    withFirstChunkTimeout = mod.withFirstChunkTimeout;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the original response when timeoutMs is invalid", () => {
    const res = new Response("ok");
    expect(withFirstChunkTimeout(res, 0)).toBe(res);
    expect(withFirstChunkTimeout(res, -1)).toBe(res);
    expect(withFirstChunkTimeout(res, null)).toBe(res);
  });

  it("passes through a response with no body", () => {
    const res = new Response(null, { status: 204 });
    expect(withFirstChunkTimeout(res, 100)).toBe(res);
  });

  it("does not abort when first chunk arrives in time", async () => {
    const res = new Response(makeSlowStream(5), {
      headers: { "content-type": "text/event-stream" },
    });
    const wrapped = withFirstChunkTimeout(res, 100);
    const reader = wrapped.body.getReader();
    const { value, done } = await reader.read();
    expect(done).toBe(false);
    expect(value).toBeDefined();
    await reader.cancel();
  });

  it("aborts when first chunk is too slow", async () => {
    const res = new Response(makeSlowStream(200), {
      headers: { "content-type": "text/event-stream" },
    });
    const wrapped = withFirstChunkTimeout(res, 50);
    const reader = wrapped.body.getReader();
    let err;
    try {
      await reader.read();
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.name).toBe("TimeoutError");
  });
});

describe("proxyAwareFetch first-chunk timeout integration", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.STREAM_FIRST_CHUNK_TIMEOUT_MS;
    vi.restoreAllMocks();
  });

  it("does not wrap SSE stream responses (first-chunk timeout is handled by streamHandler)", async () => {
    process.env.STREAM_FIRST_CHUNK_TIMEOUT_MS = "50";
    const upstreamResponse = new Response(makeSlowStream(200), {
      headers: { "content-type": "text/event-stream" },
    });
    const upstream = vi.fn().mockResolvedValue(upstreamResponse);
    globalThis.fetch = upstream;

    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

    const res = await proxyAwareFetch("https://api.example.com/chat", {
      method: "POST",
      headers: { Accept: "text/event-stream" },
      body: "{}",
    });

    expect(upstream).toHaveBeenCalledTimes(1);
    expect(res).toBe(upstreamResponse);
    await res.body.cancel();
  });

  it("does not wrap non-streaming responses", async () => {
    process.env.STREAM_FIRST_CHUNK_TIMEOUT_MS = "50";
    const upstreamResponse = new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    });
    const upstream = vi.fn().mockResolvedValue(upstreamResponse);
    globalThis.fetch = upstream;

    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

    const res = await proxyAwareFetch("https://api.example.com/chat", {
      method: "POST",
      headers: { Accept: "application/json" },
      body: "{}",
    });

    expect(upstream).toHaveBeenCalledTimes(1);
    expect(res).toBe(upstreamResponse);
    const json = await res.json();
    expect(json.ok).toBe(true);
  });
});
