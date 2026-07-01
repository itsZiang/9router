import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createStreamController } from "../../open-sse/utils/streamHandler.js";

// Tests the wiring pattern used in chatCore.js: request.signal (client
// disconnect) → streamController.handleDisconnect → upstream abort.
// The actual chatCore.js integration is too heavyweight for a unit test,
// so we test the mechanism in isolation.

describe("client-disconnect signal wiring", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls handleDisconnect when request.signal fires abort", () => {
    const clientController = new AbortController();
    const onDisconnect = vi.fn();
    const onTrackPending = vi.fn();

    const streamController = createStreamController({
      onDisconnect,
      onError: onTrackPending,
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      provider: "openai",
      model: "gpt-4",
    });

    // Wire request.signal → streamController (same pattern as chatCore.js)
    expect(clientController.signal.aborted).toBe(false);
    clientController.signal.addEventListener("abort", () => {
      streamController.handleDisconnect("client_disconnected");
    }, { once: true });

    // Simulate client disconnect
    clientController.abort();

    expect(streamController.isConnected()).toBe(false);
    expect(onDisconnect).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "client_disconnected" })
    );
  });

  it("aborts the upstream signal after the disconnect delay", () => {
    const clientController = new AbortController();
    const streamController = createStreamController({
      onDisconnect: vi.fn(),
      onError: vi.fn(),
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      provider: "anthropic",
      model: "claude-4",
    });

    clientController.signal.addEventListener("abort", () => {
      streamController.handleDisconnect("client_disconnected");
    }, { once: true });

    expect(streamController.signal.aborted).toBe(false);
    clientController.abort();

    // handleDisconnect schedules abort after 500ms
    expect(streamController.signal.aborted).toBe(false);
    vi.advanceTimersByTime(500);
    expect(streamController.signal.aborted).toBe(true);
  });

  it("handles pre-aborted signal (client already gone before request starts)", () => {
    const clientController = new AbortController();
    clientController.abort(); // already aborted

    const onDisconnect = vi.fn();
    const streamController = createStreamController({
      onDisconnect,
      onError: vi.fn(),
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      provider: "gemini",
      model: "gemini-2.5",
    });

    // Same pattern as chatCore.js: check pre-aborted
    if (clientController.signal.aborted) {
      streamController.handleDisconnect("client_aborted_before_start");
    }

    expect(streamController.isConnected()).toBe(false);
    expect(onDisconnect).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "client_aborted_before_start" })
    );
  });

  it("does not fire handleDisconnect if stream already completed", () => {
    const clientController = new AbortController();
    const onDisconnect = vi.fn();

    const streamController = createStreamController({
      onDisconnect,
      onError: vi.fn(),
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      provider: "openai",
      model: "gpt-4",
    });

    // Stream completes normally first
    streamController.handleComplete();

    // Then client disconnects
    clientController.signal.addEventListener("abort", () => {
      streamController.handleDisconnect("client_disconnected");
    }, { once: true });
    clientController.abort();

    // handleDisconnect is a no-op when already completed
    expect(streamController.isConnected()).toBe(false);
    // onDisconnect should NOT have been called (handleDisconnect early-returns)
    expect(onDisconnect).not.toHaveBeenCalled();
  });

  it("upstream fetch receives abort when client disconnects mid-stream", () => {
    const clientController = new AbortController();
    const streamController = createStreamController({
      onDisconnect: vi.fn(),
      onError: vi.fn(),
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      provider: "openai",
      model: "gpt-4",
    });

    // Wire signal
    clientController.signal.addEventListener("abort", () => {
      streamController.handleDisconnect("client_disconnected");
    }, { once: true });

    // Before disconnect: signal not aborted, still connected
    expect(streamController.signal.aborted).toBe(false);
    expect(streamController.isConnected()).toBe(true);

    // Client disconnects
    clientController.abort();
    vi.advanceTimersByTime(500);

    // After disconnect: upstream signal is aborted (fetch will throw AbortError)
    expect(streamController.signal.aborted).toBe(true);
    expect(streamController.isConnected()).toBe(false);
  });
});
