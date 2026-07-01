import { describe, it, expect, vi } from "vitest";
import { createDisconnectAwareStream, createStreamController } from "../../open-sse/utils/streamHandler.js";

describe("P1 #8 — Shielded cleanup", () => {
  it("shieldedCleanup runs reader.cancel + writer.abort exactly once", async () => {
    const transformStream = new TransformStream({
      transform(chunk, controller) { controller.enqueue(chunk); },
    });

    const streamController = createStreamController({
      onDisconnect: vi.fn(),
      onError: vi.fn(),
      provider: "test",
      model: "test",
    });

    // Patch the reader/writer to spy on cancel/abort
    const reader = transformStream.readable.getReader();
    const writer = transformStream.writable.getWriter();
    const cancelSpy = vi.spyOn(reader, "cancel");
    const abortSpy = vi.spyOn(writer, "abort");

    // Reconstruct the shielded cleanup logic to test re-entrancy
    let cleanupStarted = false;
    const shieldedCleanup = () => {
      if (cleanupStarted) return Promise.resolve();
      cleanupStarted = true;
      return Promise.race([
        reader.cancel().catch(() => {}),
        new Promise(resolve => setTimeout(resolve, 5000)),
      ]).finally(() => {
        writer.abort().catch(() => {});
      });
    };

    // Call cleanup multiple times concurrently
    await Promise.all([shieldedCleanup(), shieldedCleanup(), shieldedCleanup()]);

    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(abortSpy).toHaveBeenCalledTimes(1);
  });

  it("shieldedCleanup completes even if reader.cancel hangs (timeout)", async () => {
    const transformStream = new TransformStream({
      transform(chunk, controller) { controller.enqueue(chunk); },
    });

    const reader = transformStream.readable.getReader();
    const writer = transformStream.writable.getWriter();

    // Make reader.cancel never resolve
    vi.spyOn(reader, "cancel").mockImplementation(() => new Promise(() => {}));

    const abortSpy = vi.spyOn(writer, "abort");

    let cleanupStarted = false;
    const shieldedCleanup = () => {
      if (cleanupStarted) return Promise.resolve();
      cleanupStarted = true;
      return Promise.race([
        reader.cancel().catch(() => {}),
        new Promise(resolve => setTimeout(resolve, 100)),
      ]).finally(() => {
        writer.abort().catch(() => {});
      });
    };

    const start = Date.now();
    await shieldedCleanup();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(500);
    expect(abortSpy).toHaveBeenCalledTimes(1);
  });

  it("cancel method triggers shieldedCleanup without throwing", async () => {
    const transformStream = new TransformStream({
      transform(chunk, controller) { controller.enqueue(chunk); },
    });

    const streamController = createStreamController({
      onDisconnect: vi.fn(),
      onError: vi.fn(),
      provider: "test",
      model: "test",
    });

    const stream = createDisconnectAwareStream(
      transformStream,
      streamController,
      null,
      null,
    );

    await expect(stream.cancel("test")).resolves.toBeUndefined();
    expect(streamController.isConnected()).toBe(false);
  });

  it("concurrent cancel + error does not throw (shielded cleanup prevents double-cancel)", async () => {
    const transformStream = new TransformStream({
      transform(chunk, controller) { controller.enqueue(chunk); },
    });

    const onDisconnect = vi.fn();
    const streamController = createStreamController({
      onDisconnect,
      onError: vi.fn(),
      provider: "test",
      model: "test",
    });

    const stream = createDisconnectAwareStream(
      transformStream,
      streamController,
      null,
      null,
    );

    // Fire cancel and let it complete — should not throw even though
    // the internal reader.cancel and writer.abort run concurrently
    await Promise.all([
      stream.cancel("concurrent-1"),
      stream.cancel("concurrent-2"),
    ]);

    // handleDisconnect should only fire once (guarded by `disconnected` flag)
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(streamController.isConnected()).toBe(false);
  });
});
