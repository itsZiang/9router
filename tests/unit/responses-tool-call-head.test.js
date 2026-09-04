// Regression: tool_calls[].id reaching OpenAI-protocol clients must always be
// a string with the head chunk (id + type + name) emitted first.
// Covers: numeric upstream call_ids (ai-sdk "Expected 'id' to be a string"),
// done-only payloads (no output_item.added), and deltas arriving before added.
import { describe, it, expect } from "vitest";
import "../translator/registerAll.js";
import { translateResponse, initState } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

function runStream(events) {
  const state = initState(FORMATS.OPENAI_RESPONSES);
  const all = [];
  for (const ev of events) {
    const out = translateResponse(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, ev, state);
    if (Array.isArray(out)) all.push(...out);
    else if (out) all.push(out);
  }
  return all;
}

function toolCallDeltas(chunks) {
  return chunks.flatMap((c) => c?.choices?.[0]?.delta?.tool_calls || []);
}

function added(model, callId, name) {
  return {
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "function_call", id: "fc_1", call_id: callId, name, arguments: "" },
  };
}

function delta(args) {
  return { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: args };
}

function done(callId, name, args) {
  return {
    type: "response.output_item.done",
    output_index: 0,
    item: { type: "function_call", id: "fc_1", call_id: callId, name, arguments: args },
  };
}

describe("responses -> openai tool-call head", () => {
  it("coerces a numeric upstream call_id to string (ai-sdk rejects numbers)", () => {
    const chunks = runStream([
      added("m", 12345, "read"),
      delta('{"path":"a"}'),
      done(12345, "read", '{"path":"a"}'),
    ]);
    const tcs = toolCallDeltas(chunks);
    expect(tcs.length).toBeGreaterThan(0);
    for (const tc of tcs) {
      if (tc.id !== undefined) {
        expect(typeof tc.id).toBe("string");
        expect(tc.id).toBe("12345");
      }
    }
    // Head chunk carries id + type + name.
    expect(tcs[0]).toMatchObject({ index: 0, id: "12345", type: "function" });
    expect(tcs[0].function.name).toBe("read");
  });

  it("emits a complete head chunk for done-only payloads (no added/delta before)", () => {
    const chunks = runStream([done("call_abc", "bash", '{"cmd":"ls"}')]);
    const tcs = toolCallDeltas(chunks);
    expect(tcs).toHaveLength(1);
    expect(tcs[0]).toMatchObject({
      index: 0,
      id: "call_abc",
      type: "function",
    });
    expect(tcs[0].function).toMatchObject({ name: "bash", arguments: '{"cmd":"ls"}' });
  });

  it("buffers deltas arriving before added and folds them into the head (no id-less head)", () => {
    const chunks = runStream([
      delta('{"path"'),
      delta(':"a"}'),
      added("m", "call_xyz", "read"),
      done("call_xyz", "read", '{"path":"a"}'),
    ]);
    const tcs = toolCallDeltas(chunks);
    expect(tcs.length).toBeGreaterThan(0);
    // The first emitted chunk for the index must carry a string id.
    expect(typeof tcs[0].id).toBe("string");
    expect(tcs[0].id).toBe("call_xyz");
    // Arguments are lossless: swallowed deltas were folded into the head.
    const assembled = tcs.map((tc) => tc.function?.arguments || "").join("");
    expect(JSON.parse(assembled)).toEqual({ path: "a" });
  });

  it("keeps the normal added -> delta -> done shape byte-identical (head args empty)", () => {
    const chunks = runStream([
      added("m", "call_1", "read"),
      delta('{"p":1}'),
      done("call_1", "read", '{"p":1}'),
    ]);
    const tcs = toolCallDeltas(chunks);
    expect(tcs[0]).toMatchObject({ index: 0, id: "call_1", type: "function" });
    expect(tcs[0].function).toMatchObject({ name: "read", arguments: "" });
    // Delta chunks still carry no id (Claude Code ACP contract).
    expect(tcs[1].id).toBeUndefined();
    expect(tcs[1].function).toMatchObject({ arguments: '{"p":1}' });
  });

  it("round-trips the coerced id back to upstream on the follow-up turn", async () => {
    const { openaiToOpenAIResponsesRequest } = await import(
      "../../open-sse/translator/request/openai-responses.js"
    );
    const out = openaiToOpenAIResponsesRequest(
      "muse-spark-1.3-contributor-free",
      {
        model: "oc/muse-spark-1.3-contributor-free",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: null, tool_calls: [{ id: "12345", type: "function", function: { name: "read", arguments: "{}" } }] },
          { role: "tool", tool_call_id: "12345", content: "ok" },
        ],
      },
      true,
      {},
    );
    const outputs = out.input.filter((i) => i.type === "function_call_output");
    expect(outputs).toHaveLength(1);
    expect(outputs[0].call_id).toBe("12345");
  });
});
