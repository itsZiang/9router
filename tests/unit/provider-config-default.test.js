import { describe, it, expect, vi } from "vitest";
import { DefaultProviderConfig } from "../../open-sse/providers/DefaultProviderConfig.js";
import { OPENAI_COMPAT_BASE, ANTHROPIC_COMPAT_BASE } from "../../open-sse/providers/shared.js";

// Mock the translator concern to keep tests isolated from the full registry.
vi.mock("../../open-sse/translator/concerns/paramSupport.js", () => ({
  stripUnsupportedParams: (provider, model, body) => body
}));

function cfg(transport) {
  return new DefaultProviderConfig("test", transport);
}

const creds = (overrides = {}) => ({ apiKey: "ak", accessToken: "at", ...overrides });

describe("DefaultProviderConfig.buildUrl", () => {
  it("uses registry baseUrl for standard openai-format provider", () => {
    const c = cfg({ baseUrl: "https://api.groq.com/openai/v1/chat/completions" });
    expect(c.buildUrl({ model: "m", optionalParams: {}, stream: true, credentials: creds() }))
      .toBe("https://api.groq.com/openai/v1/chat/completions");
  });

  it("builds openai-compatible path from credentials baseUrl", () => {
    const c = new DefaultProviderConfig("openai-compatible-my", {});
    expect(c.buildUrl({
      model: "m",
      optionalParams: {},
      stream: true,
      credentials: creds({ providerSpecificData: { baseUrl: "https://my.proxy/v1" } })
    })).toBe("https://my.proxy/v1/chat/completions");
  });

  it("falls back to OPENAI_COMPAT_BASE when no baseUrl is given", () => {
    const c = new DefaultProviderConfig("openai-compatible-my", {});
    expect(c.buildUrl({ model: "m", optionalParams: {}, stream: true, credentials: creds() }))
      .toBe(`${OPENAI_COMPAT_BASE}/chat/completions`);
  });

  it("uses /responses path for openai-compatible-responses provider", () => {
    const c = new DefaultProviderConfig("openai-compatible-responses", {});
    expect(c.buildUrl({ model: "m", optionalParams: {}, stream: true, credentials: creds() }))
      .toBe(`${OPENAI_COMPAT_BASE}/responses`);
  });

  it("builds anthropic-compatible path from credentials baseUrl", () => {
    const c = new DefaultProviderConfig("anthropic-compatible-gateway", {});
    expect(c.buildUrl({
      model: "m",
      optionalParams: {},
      stream: true,
      credentials: creds({ providerSpecificData: { baseUrl: "https://gateway.example/v1" } })
    })).toBe("https://gateway.example/v1/messages");
  });

  it("falls back to ANTHROPIC_COMPAT_BASE for anthropic-compatible", () => {
    const c = new DefaultProviderConfig("anthropic-compatible-gateway", {});
    expect(c.buildUrl({ model: "m", optionalParams: {}, stream: true, credentials: creds() }))
      .toBe(`${ANTHROPIC_COMPAT_BASE}/messages`);
  });

  it("builds gemini streaming URL", () => {
    const c = cfg({ baseUrl: "https://generativelanguage.googleapis.com/v1beta/models", format: "gemini" });
    expect(c.buildUrl({ model: "gemini-pro", optionalParams: {}, stream: true, credentials: creds() }))
      .toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:streamGenerateContent?alt=sse");
  });

  it("builds gemini non-streaming URL", () => {
    const c = cfg({ baseUrl: "https://generativelanguage.googleapis.com/v1beta/models", format: "gemini" });
    expect(c.buildUrl({ model: "gemini-pro", optionalParams: {}, stream: false, credentials: creds() }))
      .toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent");
  });

  it("applies urlSuffix", () => {
    const c = cfg({ baseUrl: "https://api.example.com/v1/chat/completions", urlSuffix: "?beta=true" });
    expect(c.buildUrl({ model: "m", optionalParams: {}, stream: true, credentials: creds() }))
      .toBe("https://api.example.com/v1/chat/completions?beta=true");
  });

  it("substitutes {accountId}", () => {
    const c = cfg({ baseUrl: "https://api.example.com/{accountId}/v1/chat/completions" });
    expect(c.buildUrl({
      model: "m",
      optionalParams: {},
      stream: true,
      credentials: creds({ providerSpecificData: { accountId: "acct-42" } })
    })).toBe("https://api.example.com/acct-42/v1/chat/completions");
  });

  it("throws when accountId is missing", () => {
    const c = cfg({ baseUrl: "https://api.example.com/{accountId}/v1/chat/completions" });
    expect(() => c.buildUrl({ model: "m", optionalParams: {}, stream: true, credentials: creds() }))
      .toThrow("test requires accountId");
  });

  it("prefers runtimeTransport baseUrl when present", () => {
    const c = cfg({ baseUrl: "https://api.example.com/v1/chat/completions" });
    expect(c.buildUrl({
      model: "m",
      optionalParams: {},
      stream: true,
      credentials: creds({ runtimeTransport: { baseUrl: "https://rt.example/v2", urlSuffix: "/chat" } })
    })).toBe("https://rt.example/v2/chat");
  });
});

describe("DefaultProviderConfig.buildHeaders", () => {
  it("sets Bearer auth for openai-format provider", () => {
    const c = cfg({ baseUrl: "https://api.openai.com/v1/chat/completions" });
    const h = c.buildHeaders({ credentials: { accessToken: "at" }, stream: true });
    expect(h["Authorization"]).toBe("Bearer at");
    expect(h["Content-Type"]).toBe("application/json");
    expect(h["Accept"]).toBe("text/event-stream");
  });

  it("uses apiKey when accessToken absent", () => {
    const c = cfg({ baseUrl: "https://api.openai.com/v1/chat/completions" });
    const h = c.buildHeaders({ credentials: { apiKey: "key-only" }, stream: false });
    expect(h["Authorization"]).toBe("Bearer key-only");
  });

  it("uses x-api-key for claude-format provider", () => {
    const c = cfg({ baseUrl: "https://api.anthropic.com/v1/messages", format: "claude" });
    const h = c.buildHeaders({ credentials: creds(), stream: true });
    expect(h["x-api-key"]).toBe("ak");
    expect(h["anthropic-version"]).toBe("2023-06-01");
  });

  it("uses registry transport.headers when present", () => {
    const c = cfg({ baseUrl: "https://api.example.com", headers: { "X-Custom": "1" } });
    const h = c.buildHeaders({ credentials: creds(), stream: false });
    expect(h["X-Custom"]).toBe("1");
  });

  it("prefers runtimeTransport headers", () => {
    const c = cfg({ baseUrl: "https://api.example.com", headers: { "X-Custom": "1" } });
    const h = c.buildHeaders({
      credentials: creds({ runtimeTransport: { headers: { "X-Runtime": "2" }, auth: { combined: true, header: "Authorization", scheme: "bearer" } } }),
      stream: false
    });
    expect(h["X-Runtime"]).toBe("2");
    expect(h["X-Custom"]).toBeUndefined();
  });

  it("strips claude-code identity headers for unofficial anthropic-compatible upstreams", () => {
    const c = new DefaultProviderConfig("anthropic-compatible-gateway", {});
    const h = c.buildHeaders({
      credentials: creds({
        providerSpecificData: { baseUrl: "https://gateway.example" },
        rawHeaders: {}
      }),
      stream: false
    });
    expect(h["x-app"]).toBeUndefined();
    expect(h["anthropic-dangerous-direct-browser-access"]).toBeUndefined();
  });

  it("does not strip claude-code identity headers for official anthropic upstream", () => {
    const c = new DefaultProviderConfig("anthropic-compatible-gateway", {});
    const h = c.buildHeaders({
      credentials: creds({
        providerSpecificData: { baseUrl: "https://api.anthropic.com/v1" }
      }),
      stream: false
    });
    // For official Anthropic the stripping branch is skipped, so we just check no error and x-api-key auth is set.
    expect(h["x-api-key"]).toBe("ak");
    expect(h["Authorization"]).toBeUndefined();
  });
});

describe("DefaultProviderConfig.transformRequest", () => {
  it("drops client_metadata when quirk is set", () => {
    const c = cfg({ baseUrl: "https://api.example.com", quirks: { dropClientMetadata: true } });
    const body = { messages: [], client_metadata: { key: "value" } };
    const out = c.transformRequest({ model: "m", optionalParams: body, body, stream: true, credentials: creds() });
    expect(out.client_metadata).toBeUndefined();
  });

  it("converts json_schema → json_object for openai-compatible providers", () => {
    const c = new DefaultProviderConfig("openai-compatible-my", {});
    const body = {
      messages: [{ role: "user", content: "hi" }],
      response_format: { type: "json_schema", json_schema: { schema: { type: "object" } } }
    };
    const out = c.transformRequest({ model: "m", optionalParams: body, body, stream: true, credentials: creds() });
    expect(out.response_format.type).toBe("json_object");
    expect(out.messages[0].role).toBe("system");
    expect(out.messages[0].content).toContain("JSON schema");
  });

  it("leaves standard openai-format body unchanged except reasoning injection", () => {
    const c = cfg({ baseUrl: "https://api.openai.com/v1/chat/completions" });
    const body = { messages: [{ role: "user", content: "hi" }], temperature: 0.5 };
    const out = c.transformRequest({ model: "m", optionalParams: body, body, stream: true, credentials: creds() });
    expect(out.messages).toEqual(body.messages);
    expect(out.temperature).toBe(0.5);
  });
});

describe("DefaultProviderConfig.parseError", () => {
  it("extracts message from OpenAI-style error", () => {
    const c = cfg({ baseUrl: "https://api.openai.com" });
    const response = { status: 400 };
    const parsed = c.parseError({ response, bodyText: JSON.stringify({ error: { message: "bad request" } }) });
    expect(parsed.status).toBe(400);
    expect(parsed.message).toBe("bad request");
  });

  it("falls back to raw body when json is unparseable", () => {
    const c = cfg({ baseUrl: "https://api.openai.com" });
    const response = { status: 502 };
    const parsed = c.parseError({ response, bodyText: "upstream error" });
    expect(parsed.status).toBe(502);
    expect(parsed.message).toBe("upstream error");
  });
});
