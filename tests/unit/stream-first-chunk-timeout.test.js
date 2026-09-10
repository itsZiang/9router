import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { pipeWithDisconnect } from "../../open-sse/utils/streamHandler.js";
import { STREAM_IDLE_TIMEOUT_MS as STALL_WATCHDOG_BUDGET_MS } from "../../open-sse/config/constants.js";

describe("pipeWithDisconnect first-chunk timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts when no chunk arrives within STREAM_FIRST_CHUNK_TIMEOUT_MS", async () => {
    // NOTE: there is no separate first-chunk timer — the unified stall
    // watchdog (budget DEFAULT_STREAM_STALL_TIMEOUT_MS = constants
    // STREAM_IDLE_TIMEOUT_MS) fires for a hung upstream and reports "stream
    // stall timeout". This test advances past THAT budget and locks the
    // covering behavior: a silent upstream never hangs the client forever.
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

    // Let pipeThrough setup run: TransformStream start hooks (which arm the
    // stall watchdog) execute as microtasks, and this test never pulls, so
    // flush them explicitly before advancing the fake clock.
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.abort).not.toHaveBeenCalled();

    // Advance just past the stall-watchdog budget.
    vi.advanceTimersByTime(STALL_WATCHDOG_BUDGET_MS + 1000);

    expect(controller.handleError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "stream stall timeout" })
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

    // Within the re-armed budget window: no stall error must fire.
    vi.advanceTimersByTime(STALL_WATCHDOG_BUDGET_MS - 60000);

    const stallErrors = () => ctrl.handleError.mock.calls.filter(
      ([err]) => err?.message === "stream stall timeout"
    );
    expect(stallErrors()).toHaveLength(0);
    expect(ctrl.abort).not.toHaveBeenCalled();

    // Continued silence past the re-armed budget: the watchdog fires.
    vi.advanceTimersByTime(120000);
    expect(stallErrors()).toHaveLength(1);
    expect(ctrl.abort).toHaveBeenCalled();
  });
});
