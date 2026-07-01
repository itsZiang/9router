import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { pipeWithDisconnect } from "../../open-sse/utils/streamHandler.js";
import { STREAM_FIRST_CHUNK_TIMEOUT_MS } from "../../open-sse/config/runtimeConfig.js";

describe("pipeWithDisconnect first-chunk timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts when no chunk arrives within STREAM_FIRST_CHUNK_TIMEOUT_MS", () => {
    const controller = {
      signal: { aborted: false },
      isConnected: () => true,
      handleComplete: vi.fn(),
      handleError: vi.fn(),
      handleDisconnect: vi.fn(),
      abort: vi.fn(),
    };

    const providerResponse = {
      body: new ReadableStream({
        start() {
          // never push a chunk
        },
      }),
    };

    const transformStream = new TransformStream();

    pipeWithDisconnect(providerResponse, transformStream, controller);

    expect(controller.abort).not.toHaveBeenCalled();

    // Advance just past the first-chunk timeout
    vi.advanceTimersByTime(STREAM_FIRST_CHUNK_TIMEOUT_MS + 1000);

    expect(controller.handleError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "stream first-chunk timeout" })
    );
    expect(controller.abort).toHaveBeenCalled();
  });

  it("does not abort when the first chunk arrives promptly", async () => {
    const ctrl = {
      signal: { aborted: false },
      isConnected: () => true,
      handleComplete: vi.fn(),
      handleError: vi.fn(),
      handleDisconnect: vi.fn(),
      abort: vi.fn(),
    };

    let push;
    const providerResponse = {
      body: new ReadableStream({
        start(c) {
          push = (chunk) => c.enqueue(chunk);
        },
      }),
    };

    const transformStream = new TransformStream();

    const stream = pipeWithDisconnect(providerResponse, transformStream, ctrl);
    const reader = stream.getReader();

    // Push a chunk before timeout
    push(new Uint8Array([1, 2, 3]));

    // Consume the stream so the pipe pulls the chunk through upstreamTap
    await reader.read();

    // Advance past the timeout
    vi.advanceTimersByTime(STREAM_FIRST_CHUNK_TIMEOUT_MS + 1000);

    // Should not have fired the first-chunk timeout error
    const firstChunkErrors = ctrl.handleError.mock.calls.filter(
      ([err]) => err?.message === "stream first-chunk timeout"
    );
    expect(firstChunkErrors).toHaveLength(0);
    expect(ctrl.abort).not.toHaveBeenCalled();
  });
});
