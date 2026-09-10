import { describe, it, expect } from "vitest";

import {
  normalizeSearchToken,
  splitSearchQuery,
  matchModelWithScore,
  filterGroupedModels,
} from "@/shared/utils/modelSearch.js";

// Mirror of the reported inferx data shape from ModelSelectModal:
// nodeModels/registeredCustom entries { id, name, value } grouped per provider.
function makeGroups() {
  return {
    "openai-compatible-chat-498a": {
      name: "inferx",
      alias: "inferx",
      models: [
        { id: "Qwen3.8-27B-FP8", name: "Qwen3.8-27B-FP8", value: "inferx/Qwen3.8-27B-FP8" },
        { id: "qwen38-flash-next", name: "qwen38-flash-next", value: "inferx/qwen38-flash-next" },
        { id: "deepseek-v4-flash-0731", name: "deepseek-v4-flash-0731", value: "inferx/deepseek-v4-flash-0731" },
        { id: "glm-5.3-flash", name: "glm-5.3-flash", value: "inferx/glm-5.3-flash" },
      ],
    },
    "openai-compatible-chat-bai": {
      name: "bai",
      alias: "bai",
      models: [
        { id: "qwen3.8-flash", name: "qwen3.8-flash", value: "bai/qwen3.8-flash" },
      ],
    },
    "openai-compatible-chat-kyma": {
      name: "kyma",
      alias: "kyma",
      models: [
        { id: "qwen3.8-flash", name: "qwen3.8-flash", value: "kyma/qwen3.8-flash" },
        { id: "gpt-5.6-luna", name: "gpt-5.6-luna", value: "kyma/gpt-5.6-luna" },
        { id: "gpt-5.6-luna-pro", name: "gpt-5.6-luna-pro", value: "kyma/gpt-5.6-luna-pro" },
        { id: "gemini-3.5-flash", name: "gemini-3.5-flash", value: "kyma/gemini-3.5-flash" },
        { id: "gemini-3.5-flash-lite", name: "gemini-3.5-flash-lite", value: "kyma/gemini-3.5-flash-lite" },
      ],
    },
  };
}

describe("modelSearch utils", () => {
  it("normalizes separators and case", () => {
    expect(normalizeSearchToken("Qwen3.8-Flash")).toBe("qwen38flash");
    expect(normalizeSearchToken("qwen/qwen3.7-flash")).toBe("qwenqwen37flash");
    expect(normalizeSearchToken("glm-5.2:dev")).toBe("glm52dev");
  });

  it("splits query on whitespace and separators (version-tolerant)", () => {
    expect(splitSearchQuery("  qwen3.8-flash  ")).toEqual(["qwen3", "8", "flash"]);
    expect(splitSearchQuery("inferx flash")).toEqual(["inferx", "flash"]);
    expect(splitSearchQuery("inferx/qwen38-flash-next")).toEqual(["inferx", "qwen38", "flash", "next"]);
  });

  it("reported case: qwen3.8-flash exact-matches bai/kyma, fuzzy-suggests inferx qwen38-flash-next", () => {
    const groups = makeGroups();
    const out = filterGroupedModels(groups, "qwen3.8-flash");
    // Exact providers present and ranked first inside their groups
    expect(Object.keys(out)).toContain("openai-compatible-chat-bai");
    expect(Object.keys(out)).toContain("openai-compatible-chat-kyma");
    // inferx is no longer hidden: fuzzy tier suggests similar model names
    expect(Object.keys(out)).toContain("openai-compatible-chat-498a");
    const inferxIds = out["openai-compatible-chat-498a"].models.map((m) => m.id);
    expect(inferxIds).toContain("qwen38-flash-next");
    // Exact hit outranks fuzzy hit
    const exact = matchModelWithScore("qwen3.8-flash",
      { id: "qwen3.8-flash", name: "qwen3.8-flash", value: "bai/qwen3.8-flash" },
      { name: "bai", alias: "bai" });
    const fuzzy = matchModelWithScore("qwen3.8-flash",
      { id: "qwen38-flash-next", name: "qwen38-flash-next", value: "inferx/qwen38-flash-next" },
      { name: "inferx", alias: "inferx" });
    expect(exact.matched).toBe(true);
    expect(fuzzy.matched).toBe(true);
    expect(exact.tier).toBeLessThan(fuzzy.tier);
  });

  it("multi-token AND: 'qwen flash' matches non-contiguous names", () => {
    const out = filterGroupedModels(makeGroups(), "qwen flash");
    const inferxIds = out["openai-compatible-chat-498a"].models.map((m) => m.id);
    expect(inferxIds).toContain("qwen38-flash-next");
    // deepseek model has flash but no qwen -> excluded from inferx results
    expect(inferxIds).not.toContain("deepseek-v4-flash-0731");
  });

  it("provider scoping via text: 'inferx flash' only keeps inferx", () => {
    const out = filterGroupedModels(makeGroups(), "inferx flash");
    expect(Object.keys(out)).toEqual(["openai-compatible-chat-498a"]);
    const ids = out["openai-compatible-chat-498a"].models.map((m) => m.id);
    expect(ids).toContain("qwen38-flash-next");
    expect(ids).toContain("glm-5.3-flash");
    expect(ids).not.toContain("Qwen3.8-27B-FP8");
  });

  it("bare provider query shows the whole provider group", () => {
    const out = filterGroupedModels(makeGroups(), "inferx");
    expect(Object.keys(out)).toEqual(["openai-compatible-chat-498a"]);
    expect(out["openai-compatible-chat-498a"].models).toHaveLength(4);
  });

  it("value/pasted queries match: 'inferx/qwen' and full value", () => {
    const byPrefix = filterGroupedModels(makeGroups(), "inferx/qwen");
    expect(Object.keys(byPrefix)).toEqual(["openai-compatible-chat-498a"]);
    const full = filterGroupedModels(makeGroups(), "inferx/qwen38-flash-next");
    expect(full["openai-compatible-chat-498a"].models.map((m) => m.id))
      .toContain("qwen38-flash-next");
  });

  it("generic gpt case: 'gpt luna' matches both, exact full id ranks first", () => {
    const out = filterGroupedModels(makeGroups(), "gpt luna");
    const ids = out["openai-compatible-chat-kyma"].models.map((m) => m.id);
    expect(ids).toEqual(["gpt-5.6-luna", "gpt-5.6-luna-pro"]);
    const ranked = filterGroupedModels(makeGroups(), "gpt-5.6-luna");
    expect(ranked["openai-compatible-chat-kyma"].models[0].id).toBe("gpt-5.6-luna");
  });

  it("generic gemini case: case-insensitive + version-in-the-middle", () => {
    const out = filterGroupedModels(makeGroups(), "GEMINI-FLASH");
    const ids = out["openai-compatible-chat-kyma"].models.map((m) => m.id);
    expect(ids).toContain("gemini-3.5-flash");
    expect(ids).toContain("gemini-3.5-flash-lite");
  });

  it("separator-less query still matches dotted ids via normalization", () => {
    const out = filterGroupedModels(makeGroups(), "qwen38");
    const inferxIds = out["openai-compatible-chat-498a"].models.map((m) => m.id);
    expect(inferxIds).toContain("qwen38-flash-next");
    // Dotted variant matches too (normalized "qwen38" ⊂ "qwen3827bfp8")
    expect(inferxIds).toContain("Qwen3.8-27B-FP8");
  });

  it("alias differing from id: matches either side", () => {
    const groups = {
      p1: {
        name: "comet",
        alias: "comet",
        models: [{ id: "qwen3.6-plus", name: "openmodel-qwen3.6-plus", value: "comet/qwen3.6-plus" }],
      },
    };
    expect(filterGroupedModels(groups, "openmodel")["p1"].models).toHaveLength(1);
    expect(filterGroupedModels(groups, "qwen3.6-plus")["p1"].models).toHaveLength(1);
  });

  it("empty query keeps everything; placeholder never matches a query", () => {
    const groups = makeGroups();
    groups["openai-compatible-chat-498a"].models.push({
      id: "__placeholder__openai-compatible-chat-498a",
      name: "inferx/model-id",
      value: "inferx/model-id",
      isPlaceholder: true,
    });
    const all = filterGroupedModels(groups, "");
    expect(all["openai-compatible-chat-498a"].models.length).toBe(5);
    const searched = filterGroupedModels(groups, "flash");
    const ids = searched["openai-compatible-chat-498a"].models.map((m) => m.id);
    expect(ids).not.toContain("__placeholder__openai-compatible-chat-498a");
  });

  it("no match hides the group (no false positives)", () => {
    const out = filterGroupedModels(makeGroups(), "zzz-no-such-model-zzz");
    expect(Object.keys(out)).toHaveLength(0);
  });
});
