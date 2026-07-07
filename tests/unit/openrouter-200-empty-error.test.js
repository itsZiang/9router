// Integration regression tests for the OpenRouter HTTP-200-but-empty bug.
//
// OpenRouter free-tier models sometimes return HTTP 200 with a JSON body carrying an
// `error` field and no usable choices/output (rate-limit / quota / "no available providers").
// Two defects followed (#A + #B):
//
//   #A — the client received a generic "returned an empty response (no usable choices/output)"
//        502; the real upstream `error.message` was swallowed because the non-stream JSON path
//        never extracted `body.error`.
//   #B — saveRequestUsage was inserted TWICE per request: once as a "200" success row (with the
//        real upstream tokens) and once as a "502" failure row (zero tokens). Contradictory data.
//
// These tests drive handleChatCore end-to-end with an executor mock that returns such a body.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { executeMock, saveUsageMock, appendLogMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  saveUsageMock: vi.fn(async () => {}),
  appendLogMock: vi.fn(async () => {}),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    noAuth: true,
    execute: executeMock,
  }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("../../open-sse/utils/stream.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    COLORS: { red: "", reset: "", green: "" },
    createPassthroughStreamWithLogger: vi.fn(() => new TransformStream()),
  };
});

vi.mock("@/lib/usageDb.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    trackPendingRequest: vi.fn(),
    appendRequestLog: appendLogMock,
    saveRequestDetail: vi.fn(async () => {}),
    saveCallLog: vi.fn(async () => {}),
    saveRequestUsage: saveUsageMock,
  };
});

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

const OR_ERROR_BODY = {
  id: "gen-93c54838",
  model: "cohere/north-mini-code:free",
  created: 1752000000,
  usage: { prompt_tokens: 10, completion_tokens: 0 },
  error: { code: 429, message: "No available providers for this model." }
};

function baseArgs(overrides = {}) {
  return {
    body: {
      model: "openrouter/cohere/north-mini-code:free",
      stream: false,
      messages: [{ role: "user", content: "hello" }]
    },
    modelInfo: { provider: "openrouter", model: "cohere/north-mini-code:free" },
    credentials: { apiKey: "test-key", providerSpecificData: {} },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    connectionId: "test-conn",
    rtkEnabled: false,
    cavemanEnabled: false,
    ponytailEnabled: false,
    clientRawRequest: {
      endpoint: "/v1/chat/completions",
      body: {},
      headers: { accept: "application/json" }
    },
    ...overrides
  };
}

describe("OpenRouter HTTP-200-but-empty (#A real message, #B single usage row)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeMock.mockResolvedValue({
      response: new Response(JSON.stringify(OR_ERROR_BODY), {
        status: 200,
        headers: { "content-type": "application/json" }
      }),
      url: "https://openrouter.ai/api/v1/chat/completions",
      headers: {},
      transformedBody: null
    });
  });

  it("#A: surfaces the real upstream error.message instead of the generic empty-response 502", async () => {
    const result = await handleChatCore(baseArgs());
    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    // The real, actionable upstream message must reach the client — not the generic
    // "returned an empty response (no usable choices/output)" string.
    expect(result.error).toContain("No available providers for this model.");
    expect(result.error).not.toContain("no usable choices/output");
  });

  it("#B: records exactly ONE usage row (the 502 failure), not a 200-success + 502-failure pair", async () => {
    await handleChatCore(baseArgs());
    expect(saveUsageMock).toHaveBeenCalledTimes(1);
    const entry = saveUsageMock.mock.calls[0][0];
    expect(entry.status).toBe("502");
    expect(entry.success).toBe(false);
  });
});
