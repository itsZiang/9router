// Regression: oc/muse-spark-*-contributor-free must route to the Responses API.
// Upstream 500s these models on /chat/completions; they are served by
// /zen/v1/responses (see decolua/9router acb5c34c).
import { describe, it, expect, vi } from "vitest";
import { getModelTargetFormat, PROVIDER_MODELS } from "../../open-sse/config/providerModels.js";
import { isMuseSparkModel } from "../../open-sse/providers/models/helpers.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { resolveChatCoreTargetFormat } from "../../open-sse/handlers/chatCore/targetFormat.js";
import { OpencodeExecutor } from "../../open-sse/executors/opencode.js";
import { openaiToOpenAIResponsesRequest } from "../../open-sse/translator/request/openai-responses.js";
import { openaiResponsesToOpenAIResponse } from "../../open-sse/translator/response/openai-responses.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import { logUsage } from "../../open-sse/utils/usageTracking.js";

const MODELS = [
  "muse-spark-1.2-contributor-free",
  "muse-spark-1.3-contributor-free",
];

describe("opencode muse-spark responses routing", () => {
  it("isMuseSparkModel matches the family (incl. suffixed/prefixed variants)", () => {
    for (const m of [...MODELS, "muse-spark-2.0-contributor-free", "muse-spark-1.3-contributor-free(high)", "oc/muse-spark-1.2-contributor-free"]) {
      expect(isMuseSparkModel(m)).toBe(true);
    }
    expect(isMuseSparkModel("big-pickle")).toBe(false);
    expect(isMuseSparkModel("")).toBe(false);
    expect(isMuseSparkModel(null)).toBe(false);
  });

  it("static catalog declares both models as openai-responses", () => {
    for (const m of MODELS) {
      expect(PROVIDER_MODELS.oc?.some((e) => e.id === m && e.targetFormat === "openai-responses")).toBe(true);
      expect(PROVIDER_MODELS["opencode-zen"]?.some((e) => e.id === m && e.targetFormat === "openai-responses")).toBe(true);
    }
  });

  it("getModelTargetFormat routes muse-spark to openai-responses on oc/opencode/opencode-zen", () => {
    for (const m of [...MODELS, "muse-spark-9.9-contributor-free"]) {
      expect(getModelTargetFormat("oc", m)).toBe("openai-responses");
      expect(getModelTargetFormat("opencode", m)).toBe("openai-responses");
      expect(getModelTargetFormat("opencode-zen", m)).toBe("openai-responses");
    }
    // Scoped: other providers keep their own routing.
    expect(getModelTargetFormat("openai", MODELS[0])).toBeNull();
    // Other oc models stay on Chat Completions.
    expect(getModelTargetFormat("oc", "big-pickle")).toBeNull();
    expect(getModelTargetFormat("opencode-zen", "big-pickle")).toBeNull();
  });

  it("chatCore target-format resolution picks openai-responses", () => {
    for (const provider of ["opencode", "opencode-zen"]) {
      const { targetFormat } = resolveChatCoreTargetFormat({
        provider,
        resolvedModel: MODELS[1],
        apiFormat: "chat",
        customModelTargetFormat: null,
        providerSpecificData: null,
      });
      expect(targetFormat).toBe("openai-responses");
    }
  });

  it("executor builds the /responses URL for muse-spark and /chat/completions otherwise", () => {
    const executor = new OpencodeExecutor("opencode-zen");
    executor._requestFormat = getModelTargetFormat("opencode-zen", MODELS[1]) || "openai";
    expect(executor.buildUrl(MODELS[1])).toBe("https://opencode.ai/zen/v1/responses");

    executor._requestFormat = getModelTargetFormat("opencode-zen", "big-pickle") || "openai";
    expect(executor.buildUrl("big-pickle")).toBe("https://opencode.ai/zen/v1/chat/completions");
  });

  it("capabilities declare vision+reasoning for muse-spark", () => {
    for (const m of [...MODELS, "muse-spark-9.9-contributor-free"]) {
      expect(getCapabilitiesForModel("opencode", m)).toMatchObject({
        vision: true,
        reasoning: true,
        thinkingFormat: "openai",
        contextWindow: 1048576,
        maxOutput: 131072,
      });
    }
  });
});

describe("muse-spark tool_choice sanitize (upstream only supports auto)", () => {
  const baseBody = {
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name: "read", description: "read", parameters: { type: "object", properties: {} } } }],
  };
  const MODEL = MODELS[1];

  it('tool_choice "none" strips tools + tool_choice (compaction/summarization turns)', () => {
    const out = openaiToOpenAIResponsesRequest(MODEL, { ...baseBody, tool_choice: "none" }, true, null);
    expect(out.tool_choice).toBeUndefined();
    expect(out.tools).toBeUndefined();
  });

  it('tool_choice "required" degrades to "auto" and keeps tools', () => {
    const out = openaiToOpenAIResponsesRequest(MODEL, { ...baseBody, tool_choice: "required" }, true, null);
    expect(out.tool_choice).toBe("auto");
    expect(out.tools).toHaveLength(1);
  });

  it("named function choice degrades to auto (Responses {type,name} shape)", () => {
    const out = openaiToOpenAIResponsesRequest(
      MODEL,
      { ...baseBody, tool_choice: { type: "function", function: { name: "read" } } },
      true,
      null
    );
    expect(out.tool_choice).toBe("auto");
    expect(out.tools).toHaveLength(1);
  });

  it('tool_choice "auto" and absent pass through untouched', () => {
    const autoOut = openaiToOpenAIResponsesRequest(MODEL, { ...baseBody, tool_choice: "auto" }, true, null);
    expect(autoOut.tool_choice).toBe("auto");
    expect(autoOut.tools).toHaveLength(1);
    const absentOut = openaiToOpenAIResponsesRequest(MODEL, { ...baseBody }, true, null);
    expect(absentOut.tool_choice).toBeUndefined();
    expect(absentOut.tools).toHaveLength(1);
  });

  it("non-muse-spark models are not touched (no blast radius)", () => {
    const out = openaiToOpenAIResponsesRequest("big-pickle", { ...baseBody, tool_choice: "none" }, true, null);
    expect(out.tool_choice).toBe("none");
    expect(out.tools).toHaveLength(1);
    const requiredOut = openaiToOpenAIResponsesRequest("big-pickle", { ...baseBody, tool_choice: "required" }, true, null);
    expect(requiredOut.tool_choice).toBe("required");
  });
});

describe("muse-spark max_output_tokens floor (32k exhausted by reasoning alone)", () => {
  const baseBody = {
    messages: [{ role: "user", content: "hi" }],
  };
  const MODEL = MODELS[1];

  it("bumps opencode default max_tokens 32000 → 64000", () => {
    const out = openaiToOpenAIResponsesRequest(MODEL, { ...baseBody, max_tokens: 32000 }, true, null);
    expect(out.max_output_tokens).toBe(64000);
  });

  it("bumps max_completion_tokens 32000 → 64000 (newer field takes priority)", () => {
    const out = openaiToOpenAIResponsesRequest(MODEL, { ...baseBody, max_completion_tokens: 16000 }, true, null);
    expect(out.max_output_tokens).toBe(64000);
  });

  it("leaves generous budgets untouched", () => {
    const out = openaiToOpenAIResponsesRequest(MODEL, { ...baseBody, max_tokens: 128000 }, true, null);
    expect(out.max_output_tokens).toBe(128000);
  });

  it("leaves absent budget untouched (upstream default applies)", () => {
    const out = openaiToOpenAIResponsesRequest(MODEL, { ...baseBody }, true, null);
    expect(out.max_output_tokens).toBeUndefined();
  });

  it("non-muse-spark models are not touched (no blast radius)", () => {
    const out = openaiToOpenAIResponsesRequest("big-pickle", { ...baseBody, max_tokens: 32000 }, true, null);
    expect(out.max_output_tokens).toBe(32000);
  });
});

describe("muse-spark incomplete → length (never masked as stop)", () => {
  const textDelta = { type: "response.output_text.delta", delta: "partial" };

  it("response.incomplete emits finish_reason length with usage", () => {
    const state = {};
    openaiResponsesToOpenAIResponse(textDelta, state);
    const finalChunk = openaiResponsesToOpenAIResponse(
      {
        type: "response.incomplete",
        response: {
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          usage: { input_tokens: 100, output_tokens: 64000, total_tokens: 64100 },
        },
      },
      state
    );
    expect(finalChunk.choices[0].finish_reason).toBe("length");
    expect(finalChunk.usage).toMatchObject({ prompt_tokens: 100, completion_tokens: 64000 });
    expect(state.responsesTerminalSeen).toBe(true);
    expect(state.responsesTerminalReason).toBe("length");
  });

  it("response.completed carrying incomplete status emits length", () => {
    const state = {};
    openaiResponsesToOpenAIResponse(textDelta, state);
    const finalChunk = openaiResponsesToOpenAIResponse(
      {
        type: "response.completed",
        response: {
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        },
      },
      state
    );
    expect(finalChunk.choices[0].finish_reason).toBe("length");
  });

  it("normal response.completed still emits stop (no tool calls)", () => {
    const state = {};
    openaiResponsesToOpenAIResponse(textDelta, state);
    const finalChunk = openaiResponsesToOpenAIResponse(
      {
        type: "response.completed",
        response: {
          status: "completed",
          usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        },
      },
      state
    );
    expect(finalChunk.choices[0].finish_reason).toBe("stop");
  });

  it("response.completed after a finished tool call still emits tool_calls", () => {
    const state = {};
    openaiResponsesToOpenAIResponse(
      { type: "response.output_item.added", item: { type: "function_call", call_id: "call_1", name: "read" } },
      state
    );
    openaiResponsesToOpenAIResponse(
      {
        type: "response.output_item.done",
        item: { type: "function_call", call_id: "call_1", name: "read", arguments: "{}" },
      },
      state
    );
    const finalChunk = openaiResponsesToOpenAIResponse(
      {
        type: "response.completed",
        response: { status: "completed", usage: { input_tokens: 10, output_tokens: 20 } },
      },
      state
    );
    expect(finalChunk.choices[0].finish_reason).toBe("tool_calls");
  });

  it("flush without any terminal event warns (premature EOF observability)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const state = {};
      openaiResponsesToOpenAIResponse(textDelta, state);
      const finalChunk = openaiResponsesToOpenAIResponse(null, state);
      expect(finalChunk.choices[0].finish_reason).toBe("stop");
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0][0])).toContain("PREMATURE EOF");
    } finally {
      warn.mockRestore();
    }
  });

  it("flush after a terminal event does not warn or double-emit", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const state = {};
      openaiResponsesToOpenAIResponse(textDelta, state);
      openaiResponsesToOpenAIResponse(
        { type: "response.completed", response: { status: "completed" } },
        state
      );
      expect(openaiResponsesToOpenAIResponse(null, state)).toBeNull();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("muse-spark USAGE diagnostics (finish/tools visible in logs)", () => {
  function responsesSSE(events) {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        for (const e of events) {
          controller.enqueue(encoder.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
        }
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
    return text + decoder.decode();
  }

  function runStream(events) {
    const onComplete = vi.fn();
    const output = responsesSSE(events).pipeThrough(
      createSSETransformStreamWithLogger(
        FORMATS.OPENAI_RESPONSES,
        FORMATS.OPENAI,
        "opencode",
        null,
        null,
        MODELS[1],
        "test-conn-diag",
        { model: `oc/${MODELS[1]}`, messages: [{ role: "user", content: "hi" }] },
        onComplete,
      ),
    );
    return readAll(output);
  }

  const usageEvents = (terminal) => [
    { type: "response.created", response: { id: "resp_diag", status: "in_progress" } },
    { type: "response.output_text.delta", delta: "short text" },
    terminal,
  ];

  it("USAGE line shows finish=stop tools=0 for a clean text turn", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runStream(usageEvents({
        type: "response.completed",
        response: { id: "resp_diag", status: "completed", usage: { input_tokens: 50, output_tokens: 21 } },
      }));
      const usageLines = log.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("[USAGE]"));
      expect(usageLines.length).toBeGreaterThan(0);
      expect(usageLines.some((m) => m.includes("finish=stop"))).toBe(true);
      expect(usageLines.some((m) => m.includes("tools=0"))).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  it("USAGE line shows finish=length for a truncated turn", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runStream(usageEvents({
        type: "response.incomplete",
        response: {
          id: "resp_diag",
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          usage: { input_tokens: 50, output_tokens: 64000 },
        },
      }));
      const usageLines = log.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("[USAGE]"));
      expect(usageLines.some((m) => m.includes("finish=length"))).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  it("USAGE line shows finish=tool_calls tools=1 for a tool turn", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runStream([
        { type: "response.created", response: { id: "resp_diag", status: "in_progress" } },
        { type: "response.output_item.added", item: { type: "function_call", call_id: "call_9", name: "read" } },
        { type: "response.output_item.done", item: { type: "function_call", call_id: "call_9", name: "read", arguments: "{}" } },
        { type: "response.completed", response: { id: "resp_diag", status: "completed", usage: { input_tokens: 50, output_tokens: 60 } } },
      ]);
      const usageLines = log.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("[USAGE]"));
      expect(usageLines.some((m) => m.includes("finish=tool_calls"))).toBe(true);
      expect(usageLines.some((m) => m.includes("tools=1"))).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  it("logUsage without extra stays backward compatible (no finish/tools suffix)", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      logUsage("opencode", { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, MODELS[1], "conn", null, 100, "ok", true);
      const line = String(log.mock.calls[0][0]);
      expect(line).toContain("[USAGE]");
      expect(line).not.toContain("finish=");
      expect(line).not.toContain("tools=");
    } finally {
      log.mockRestore();
    }
  });
});

describe("muse-spark orphaned tool-result drop warning", () => {
  const MODEL = MODELS[1];

  it("warns when a tool result has no matching function_call", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const out = openaiToOpenAIResponsesRequest(MODEL, {
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "working", tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }] },
          { role: "tool", tool_call_id: "call_2", content: "orphan result" },
        ],
      }, true, null);
      expect(out.input.filter((i) => i.type === "function_call_output")).toHaveLength(0);
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0][0])).toContain("Dropped 1/1 orphaned");
    } finally {
      warn.mockRestore();
    }
  });

  it("stays silent when all tool results are paired", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const out = openaiToOpenAIResponsesRequest(MODEL, {
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "working", tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }] },
          { role: "tool", tool_call_id: "call_1", content: "file content" },
        ],
      }, true, null);
      expect(out.input.filter((i) => i.type === "function_call_output")).toHaveLength(1);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("muse-spark per-turn summary (translator drop visibility)", () => {
  function lastTurnLine(logSpy) {
    const lines = logSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("[responses] turn"));
    return lines[lines.length - 1] || "";
  }

  it("summarizes a text turn (chars, tools, reasoning, items)", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const state = {};
      openaiResponsesToOpenAIResponse({ type: "response.output_text.delta", delta: "hello " }, state);
      openaiResponsesToOpenAIResponse({ type: "response.output_text.delta", delta: "world" }, state);
      openaiResponsesToOpenAIResponse({ type: "response.reasoning_summary_text.delta", delta: "thinking" }, state);
      openaiResponsesToOpenAIResponse(
        { type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 6 } } },
        state
      );
      const line = lastTurnLine(log);
      expect(line).toContain("status=completed");
      expect(line).toContain("textChars=11");
      expect(line).toContain("tools=0");
      expect(line).toContain("reasoning=yes");
    } finally {
      log.mockRestore();
    }
  });

  it("summarizes a tool turn with item kinds", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const state = {};
      openaiResponsesToOpenAIResponse(
        { type: "response.output_item.added", item: { type: "function_call", call_id: "call_1", name: "read" } },
        state
      );
      openaiResponsesToOpenAIResponse(
        { type: "response.output_item.done", item: { type: "function_call", call_id: "call_1", name: "read", arguments: "{}" } },
        state
      );
      openaiResponsesToOpenAIResponse(
        { type: "response.completed", response: { status: "completed" } },
        state
      );
      const line = lastTurnLine(log);
      expect(line).toContain("tools=1");
      expect(line).toContain("items=function_call");
    } finally {
      log.mockRestore();
    }
  });

  it("surfaces unknown output-item kinds instead of dropping them silently", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const state = {};
      openaiResponsesToOpenAIResponse(
        { type: "response.output_item.added", item: { type: "custom_tool_call", call_id: "call_9" } },
        state
      );
      openaiResponsesToOpenAIResponse(
        { type: "response.completed", response: { status: "completed" } },
        state
      );
      const line = lastTurnLine(log);
      expect(line).toContain("items=custom_tool_call");
      expect(line).toContain("tools=0");
    } finally {
      log.mockRestore();
    }
  });

  it("summarizes incomplete turns with status=incomplete", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const state = {};
      openaiResponsesToOpenAIResponse({ type: "response.output_text.delta", delta: "partial" }, state);
      const fin = openaiResponsesToOpenAIResponse(
        { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } },
        state
      );
      expect(fin.choices[0].finish_reason).toBe("length");
      expect(lastTurnLine(log)).toContain("status=incomplete");
    } finally {
      log.mockRestore();
    }
  });
});

describe("muse-spark snapshot-only reasoning is counted", () => {
  it("output_item.done reasoning snapshot sets reasoning=yes", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const state = {};
      openaiResponsesToOpenAIResponse(
        {
          type: "response.output_item.done",
          item: { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "thought a lot" }] },
        },
        state
      );
      openaiResponsesToOpenAIResponse(
        { type: "response.completed", response: { status: "completed" } },
        state
      );
      const lines = log.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("[responses] turn"));
      expect(lines.some((m) => m.includes("reasoning=yes"))).toBe(true);
      expect(lines.some((m) => m.includes("items=reasoning"))).toBe(true);
    } finally {
      log.mockRestore();
    }
  });
});
