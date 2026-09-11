// Cline gateway drops the terminal finish_reason chunk on tool turns: the
// stream carries complete tool_calls (names + full JSON arguments) and then
// just ends. Strict OpenAI clients (opencode via @ai-sdk/openai-compatible)
// reject that with "Stream ended without finish_reason".
//
// The passthrough EOF path must synthesize finish_reason:"tool_calls" ONLY
// when every tracked call is complete. Anything else — zero bytes, truncated
// args, empty-string args, unsettled textual tool content — keeps the legacy
// warn + [DONE] (or the 502 empty-stream error) so genuine truncations are
// never disguised as clean completions. Never synthesize "stop".
import { describe, it, expect, vi } from "vitest";
import { createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js";

const encoder = new TextEncoder();
const TERMINAL_TOOL_CALLS = '"finish_reason":"tool_calls"';

function sseStream(frames) {
  return new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(f)}\n\n`));
      controller.close();
    },
  });
}

async function readAll(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let error = null;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (e) {
    error = e;
  }
  return { text, error };
}

function toolDelta(index, id, name, argsFragment) {
  const fn = {};
  if (name !== undefined) fn.name = name;
  if (argsFragment !== undefined) fn.arguments = argsFragment;
  const tc = { index, function: fn };
  if (id !== undefined) tc.id = id;
  return { id: "chatcmpl-cline-1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { tool_calls: [tc] }, finish_reason: null }] };
}

function runPassthrough(frames) {
  const onComplete = vi.fn();
  const transform = createPassthroughStreamWithLogger(
    "cline",
    null,
    null,
    "cline-free/muse-spark-1.3-contributor",
    "test-conn",
    { model: "cl/cline-free/muse-spark-1.3-contributor", messages: [{ role: "user", content: "hi" }], max_tokens: 16384 },
    onComplete,
  );
  return { promise: readAll(sseStream(frames).pipeThrough(transform)), onComplete };
}

describe("passthrough EOF with tool_calls but no finish_reason (Cline pattern)", () => {
  it("synthesizes a tool_calls terminal before [DONE] when every call is complete", async () => {
    const { promise } = runPassthrough([
      { id: "chatcmpl-cline-1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
      toolDelta(0, "call_1", "read_file", '{"path":'),
      toolDelta(0, undefined, undefined, '"/tmp/x"}'),
    ]);
    const { text, error } = await promise;

    expect(error).toBeNull();
    expect(text).toContain(TERMINAL_TOOL_CALLS);
    expect(text).toContain("data: [DONE]");
    expect(text).not.toContain('"finish_reason":"stop"');
    // Terminal closes the stream: it must come before the sentinel.
    expect(text.lastIndexOf(TERMINAL_TOOL_CALLS)).toBeLessThan(text.lastIndexOf("data: [DONE]"));
  });

  it("synthesizes the terminal even when prose accompanies complete tools", async () => {
    const { promise } = runPassthrough([
      { id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { content: "let me check" }, finish_reason: null }] },
      toolDelta(0, "call_1", "read_file", '{"path":"/tmp/x"}'),
    ]);
    const { text, error } = await promise;

    expect(error).toBeNull();
    expect(text).toContain(TERMINAL_TOOL_CALLS);
    expect(text).toContain("data: [DONE]");
  });

  it("does NOT synthesize when arguments are truncated (invalid JSON)", async () => {
    const { promise } = runPassthrough([
      toolDelta(0, "call_1", "read_file", '{"path":'),
    ]);
    const { text, error } = await promise;

    expect(error).toBeNull();
    expect(text).not.toContain(TERMINAL_TOOL_CALLS);
    expect(text).toContain("data: [DONE]");
  });

  it("does NOT synthesize when arguments are an empty string (zero-arg or truncated-before-args)", async () => {
    const { promise } = runPassthrough([
      toolDelta(0, "call_1", "read_file", ""),
    ]);
    const { text, error } = await promise;

    expect(error).toBeNull();
    expect(text).not.toContain(TERMINAL_TOOL_CALLS);
    expect(text).toContain("data: [DONE]");
  });

  it("does NOT synthesize when a tracked call has no function name", async () => {
    const { promise } = runPassthrough([
      toolDelta(0, "call_1", undefined, '{"path":"/tmp/x"}'),
    ]);
    const { text, error } = await promise;

    expect(error).toBeNull();
    expect(text).not.toContain(TERMINAL_TOOL_CALLS);
    expect(text).toContain("data: [DONE]");
  });

  it("does NOT synthesize when one of several calls is incomplete", async () => {
    const { promise } = runPassthrough([
      toolDelta(0, "call_1", "read_file", '{"path":"/tmp/x"}'),
      toolDelta(1, "call_2", "grep", '{"pattern":'),
    ]);
    const { text, error } = await promise;

    expect(error).toBeNull();
    expect(text).not.toContain(TERMINAL_TOOL_CALLS);
    expect(text).toContain("data: [DONE]");
  });

  it("still errors (no clean [DONE]) on a zero-byte close with no tool signal", async () => {
    const { promise } = runPassthrough([]);
    const { text, error } = await promise;

    expect(error).not.toBeNull();
    expect(String(error?.message || error)).toContain("without content");
    expect(text).not.toContain("data: [DONE]");
  });
});
