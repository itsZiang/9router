// Regression: oc/muse-spark-*-contributor-free must route to the Responses API.
// Upstream 500s these models on /chat/completions; they are served by
// /zen/v1/responses (see decolua/9router acb5c34c).
import { describe, it, expect } from "vitest";
import { getModelTargetFormat, PROVIDER_MODELS } from "../../open-sse/config/providerModels.js";
import { isMuseSparkModel } from "../../open-sse/providers/models/helpers.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { resolveChatCoreTargetFormat } from "../../open-sse/handlers/chatCore/targetFormat.js";
import { OpencodeExecutor } from "../../open-sse/executors/opencode.js";
import { openaiToOpenAIResponsesRequest } from "../../open-sse/translator/request/openai-responses.js";

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
