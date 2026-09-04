// Regression: [STREAM] Error in flush (...): streamStartTime is not defined.
// The translate-mode flush() referenced an undeclared `streamStartTime`
// (the real variable is `streamStartedAt`). Any streamed model whose upstream
// returns usage (e.g. Muse Spark on the Responses API) hit a ReferenceError
// on every request: logUsage + onComplete (call-log persistence) were skipped.
import { describe, it, expect, vi, afterEach } from "vitest";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";

const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});

afterEach(() => {
  consoleLogSpy.mockClear();
});

function responsesStreamWithUsage() {
  const encoder = new TextEncoder();
  const events = [
    `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_test", status: "in_progress" } })}\n\n`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "ok" })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_test", status: "completed", usage: { input_tokens: 9, output_tokens: 16 } } })}\n\n`,
  ];
  return new ReadableStream({
    start(controller) {
      for (const e of events) controller.enqueue(encoder.encode(e));
      controller.close();
    },
  });
}

async function readAll(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

describe("translate-mode flush with upstream usage", () => {
  it("logs usage and calls onComplete without 'Error in flush' (openai-responses -> openai)", async () => {
    const onComplete = vi.fn();
    const output = responsesStreamWithUsage().pipeThrough(
      createSSETransformStreamWithLogger(
        FORMATS.OPENAI_RESPONSES,
        FORMATS.OPENAI,
        "opencode",
        null,
        null,
        "muse-spark-1.3-contributor-free",
        "test-conn-flush",
        { model: "oc/muse-spark-1.3-contributor-free", messages: [{ role: "user", content: "say ok" }] },
        onComplete,
      ),
    );

    const text = await readAll(output);

    expect(text).toContain("data: [DONE]");
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0][0]).toMatchObject({ status: 200 });
    const flushErrors = consoleLogSpy.mock.calls.filter((args) =>
      args.some((a) => typeof a === "string" && a.includes("Error in flush")),
    );
    expect(flushErrors).toEqual([]);
  });
});
