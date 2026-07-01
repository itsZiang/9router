import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

vi.mock("../../open-sse/translator/concerns/paramSupport.js", () => ({
  stripUnsupportedParams: (provider, model, body) => body
}));

const { BaseExecutor } = await import("../../open-sse/executors/base.js");
const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
const { DefaultProviderConfig } = await import("../../open-sse/providers/DefaultProviderConfig.js");

function res(status) {
  return { status, headers: { get: () => "" } };
}

beforeEach(() => fetchMock.mockReset());

describe("DefaultExecutor soft migration", () => {
  it("exposes a DefaultProviderConfig via getProviderConfig", () => {
    const ex = new DefaultExecutor("openai");
    const cfg = ex.getProviderConfig();
    expect(cfg).toBeInstanceOf(DefaultProviderConfig);
    expect(cfg.provider).toBe("openai");
  });

  it("execute delegates transform/build/sign to DefaultProviderConfig", async () => {
    const ex = new DefaultExecutor("openai");
    fetchMock.mockResolvedValueOnce(res(200));
    const cfg = ex.getProviderConfig();
    cfg.transformRequest = vi.fn((ctx) => ({ ...ctx.body, transformed: true }));
    cfg.buildHeaders = vi.fn(() => ({ "X-Test": "1" }));
    cfg.buildUrl = vi.fn(() => "https://delegated.example/v1/chat/completions");
    cfg.signRequest = vi.fn((ctx) => { ctx.headers["X-Signed"] = "yes"; });

    const out = await ex.execute({
      model: "gpt-4o",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { apiKey: "k" }
    });

    expect(cfg.transformRequest).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-4o", stream: true }));
    expect(cfg.buildHeaders).toHaveBeenCalledWith(expect.objectContaining({ stream: true }));
    expect(cfg.buildUrl).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-4o", stream: true }));
    expect(cfg.signRequest).toHaveBeenCalled();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://delegated.example/v1/chat/completions");
    expect(init.headers["X-Test"]).toBe("1");
    expect(init.headers["X-Signed"]).toBe("yes");
    expect(JSON.parse(init.body).transformed).toBe(true);
    expect(out.response.status).toBe(200);
  });

  it("buildUrl wrapper still works for external callers", () => {
    const ex = new DefaultExecutor("openai-compatible-my");
    const url = ex.buildUrl("m", true, 0, { apiKey: "k", providerSpecificData: { baseUrl: "https://my.proxy/v1" } });
    expect(url).toBe("https://my.proxy/v1/chat/completions");
  });

  it("buildHeaders wrapper still works for external callers", () => {
    const ex = new DefaultExecutor("openai");
    const h = ex.buildHeaders({ apiKey: "k" }, true);
    expect(h.Authorization).toBe("Bearer k");
    expect(h.Accept).toBe("text/event-stream");
  });

  it("transformRequest wrapper still works for external callers", () => {
    const ex = new DefaultExecutor("openai-compatible-my");
    const body = {
      messages: [{ role: "user", content: "hi" }],
      response_format: { type: "json_schema", json_schema: { schema: { type: "object" } } }
    };
    const out = ex.transformRequest("m", body);
    expect(out.response_format.type).toBe("json_object");
  });
});

describe("BaseExecutor legacy path (no provider config)", () => {
  it("uses subclass overrides when getProviderConfig returns null", async () => {
    class LegacyExecutor extends BaseExecutor {
      buildUrl(model, stream, urlIndex, credentials) {
        return "https://legacy.example/api";
      }
      buildHeaders(credentials, stream) {
        return { "X-Legacy": "1" };
      }
      transformRequest(model, body, stream, credentials) {
        return { ...body, legacy: true };
      }
    }
    fetchMock.mockResolvedValueOnce(res(200));

    const ex = new LegacyExecutor("legacy", { baseUrl: "https://x" });
    expect(ex.getProviderConfig()).toBeNull();

    const out = await ex.execute({ model: "m", body: { a: 1 }, stream: false, credentials: { apiKey: "k" } });
    expect(out.response.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://legacy.example/api");
    expect(init.headers["X-Legacy"]).toBe("1");
    expect(JSON.parse(init.body).legacy).toBe(true);
  });

  it("specialized executors without getProviderConfig remain on legacy path", async () => {
    // CursorExecutor does not override getProviderConfig, so it inherits BaseExecutor's null.
    const { CursorExecutor } = await import("../../open-sse/executors/cursor.js");
    const ex = new CursorExecutor();
    expect(ex.getProviderConfig()).toBeNull();
  });
});
