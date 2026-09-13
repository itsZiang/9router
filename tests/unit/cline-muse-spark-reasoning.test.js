// Regression: muse-spark via Cline gateway streams reasoning in `reasoning`/
// `thinking`/`thought`/`reasoning_details` — not only `reasoning_content`.
// These must count as content so reasoning-only turns don't hit
// "empty stream: no content and no finish_reason" /
// "upstream closed without finish_reason and without content".
import { describe, it, expect } from "vitest";
import { isKnownNonClaudeStreamPayload, hasValuableContent } from "../../open-sse/utils/streamHelpers.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { validateResponseQuality } from "../../open-sse/services/combo/validateQuality.js";
import { isEmptyContentResponse } from "../../open-sse/services/errorClassifier.js";

const encoder = new TextEncoder();
const log = { warn() {}, info() {} };
const chunk = (delta, finish = null) => ({ id: "1", object: "chat.completion.chunk", created: 1, model: "muse-spark", choices: [{ index: 0, delta, finish_reason: finish }] });

function sseResponse(frames) {
  const stream = new ReadableStream({
    start(c) {
      for (const f of frames) c.enqueue(encoder.encode(`data: ${JSON.stringify(f)}\n\n`));
      c.enqueue(encoder.encode("data: [DONE]\n\n"));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("muse-spark reasoning variants count as content (cline gateway)", () => {
  const variants = [
    ["reasoning", { reasoning: "think think" }],
    ["thinking", { thinking: "deep thought" }],
    ["thought", { thought: "hmm" }],
    ["reasoning_details", { reasoning_details: [{ text: "detail" }] }],
    ["reasoning_text", { reasoning_text: "rt" }],
    ["reasoning_content", { reasoning_content: "rc" }],
  ];
  for (const [name, delta] of variants) {
    it(`peek gate passes delta.${name}`, () => {
      expect(isKnownNonClaudeStreamPayload(chunk(delta))).toBe(true);
    });
    it(`hasValuableContent passes delta.${name}`, () => {
      expect(hasValuableContent(chunk(delta), FORMATS.OPENAI)).toBe(true);
    });
    it(`validateQuality passes reasoning-only (${name}) + stop`, async () => {
      const res = sseResponse([chunk(delta), chunk({}, "stop")]);
      const q = await validateResponseQuality(res, true, log, undefined);
      expect(q.valid).toBe(true);
    });
  }

  it("still rejects a truly empty stream", async () => {
    const res = sseResponse([chunk({})]);
    // no finish_reason and no content -> invalid (failover), unchanged behavior
    const q = await validateResponseQuality(
      new Response(new ReadableStream({ start(c) { c.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } }),
      true, log, undefined
    );
    expect(q.valid).toBe(false);
    expect(q.reason).toContain("no content and no finish_reason");
    expect(res).toBeDefined();
  });

  it("isEmptyContentResponse honors thinking/thought variants", () => {
    expect(isEmptyContentResponse({ choices: [{ message: { role: "assistant", content: null, reasoning: "r" }, finish_reason: "stop" }] })).toBe(false);
    expect(isEmptyContentResponse({ choices: [{ message: { role: "assistant", content: "", thinking: "t" }, finish_reason: "stop" }] })).toBe(false);
    expect(isEmptyContentResponse({ choices: [{ message: { role: "assistant", content: "" }, finish_reason: "stop" }] })).toBe(true);
  });
});
