// Regression tests for Fix A: HTTP-200 bodies that carry a provider `error` field and no
// usable output (e.g. OpenRouter free-tier rate-limit/quota) must surface their real,
// sanitized message instead of a generic "empty response" 502.
import { describe, it, expect } from "vitest";
import { extractJsonBodyErrorMessage, extractSSEErrorMessage } from "../../open-sse/handlers/sseParser.js";

describe("extractJsonBodyErrorMessage", () => {
  it("extracts message from an OpenRouter-style 200 error body", () => {
    const body = {
      id: "gen-123",
      model: "cohere/north-mini-code:free",
      error: { code: 429, message: "No available providers for this model." }
    };
    expect(extractJsonBodyErrorMessage(body)).toBe("No available providers for this model.");
  });

  it("extracts string error", () => {
    expect(extractJsonBodyErrorMessage({ error: "rate limited" })).toBe("rate limited");
  });

  it("extracts error.code when message absent", () => {
    expect(extractJsonBodyErrorMessage({ error: { code: "no_providers" } })).toBe("no_providers");
  });

  it("returns null when body has usable choices (never short-circuits a real completion)", () => {
    const body = {
      choices: [{ message: { content: "hi" } }],
      error: { message: "should be ignored" }
    };
    expect(extractJsonBodyErrorMessage(body)).toBeNull();
  });

  it("returns null when body has usable text/content/output", () => {
    expect(extractJsonBodyErrorMessage({ text: "hi" })).toBeNull();
    expect(extractJsonBodyErrorMessage({ content: [{ type: "text", text: "hi" }] })).toBeNull();
    expect(extractJsonBodyErrorMessage({ output: [{ type: "message" }] })).toBeNull();
  });

  it("returns null when no error field", () => {
    expect(extractJsonBodyErrorMessage({ id: "x", usage: {} })).toBeNull();
    expect(extractJsonBodyErrorMessage({})).toBeNull();
    expect(extractJsonBodyErrorMessage(null)).toBeNull();
  });

  it("sanitizes stack-trace/absolute-path leakage from the message", () => {
    const body = { error: { message: "boom at /home/user/open-sse/handlers/chatCore.js:42\nrest" } };
    const msg = extractJsonBodyErrorMessage(body);
    expect(msg).not.toContain("/home/user/open-sse/handlers/chatCore.js");
    expect(msg).not.toContain("\n");
  });
});

describe("extractSSEErrorMessage (parity, unchanged behavior)", () => {
  it("extracts error-only chunk from a buffered SSE stream", () => {
    const sse = `data: {"error":{"message":"Devin CLI not found"}}\n\n`;
    expect(extractSSEErrorMessage(sse)).toBe("Devin CLI not found");
  });
});
