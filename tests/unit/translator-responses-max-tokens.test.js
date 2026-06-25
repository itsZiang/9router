import { describe, it, expect } from "vitest";

import { openaiToOpenAIResponsesRequest, openaiResponsesToOpenAIRequest } from "../../open-sse/translator/request/openai-responses.js";

describe("openai-responses translator: token-limit field mapping", () => {
  describe("Chat Completions → Responses API (openaiToOpenAIResponsesRequest)", () => {
    it("maps max_tokens → max_output_tokens", () => {
      const body = {
        model: "gpt-5.4-mini",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 256,
      };

      const result = openaiToOpenAIResponsesRequest("gpt-5.4-mini", body, true, null);

      expect(result.max_output_tokens).toBe(256);
      expect(result.max_tokens).toBeUndefined();
    });

    it("maps max_completion_tokens → max_output_tokens for gpt-5/o-series", () => {
      const body = {
        model: "o3",
        messages: [{ role: "user", content: "hi" }],
        max_completion_tokens: 512,
      };

      const result = openaiToOpenAIResponsesRequest("o3", body, true, null);

      expect(result.max_output_tokens).toBe(512);
      expect(result.max_completion_tokens).toBeUndefined();
      expect(result.max_tokens).toBeUndefined();
    });

    it("prefers max_tokens over max_completion_tokens when both present", () => {
      const body = {
        model: "gpt-5.4-mini",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 100,
        max_completion_tokens: 200,
      };

      const result = openaiToOpenAIResponsesRequest("gpt-5.4-mini", body, true, null);

      expect(result.max_output_tokens).toBe(100);
    });

    it("omits max_output_tokens when neither limit field is present", () => {
      const body = {
        model: "gpt-5.4-mini",
        messages: [{ role: "user", content: "hi" }],
      };

      const result = openaiToOpenAIResponsesRequest("gpt-5.4-mini", body, true, null);

      expect(result.max_output_tokens).toBeUndefined();
      expect(result.max_tokens).toBeUndefined();
    });

    it("clamps max_tokens below 16 (Responses API minimum) up to 16", () => {
      // Test pings send max_tokens: 1 — Responses API rejects < 16 ("integer_below_min_value")
      const body = {
        model: "gpt-5.4-mini",
        messages: [{ role: "user", content: "test" }],
        max_tokens: 1,
      };

      const result = openaiToOpenAIResponsesRequest("gpt-5.4-mini", body, true, null);

      expect(result.max_output_tokens).toBe(16);
      expect(result.max_tokens).toBeUndefined();
    });

    it("clamps max_completion_tokens below 16 up to 16", () => {
      const body = {
        model: "o3",
        messages: [{ role: "user", content: "test" }],
        max_completion_tokens: 8,
      };

      const result = openaiToOpenAIResponsesRequest("o3", body, true, null);

      expect(result.max_output_tokens).toBe(16);
    });

    it("does not clamp values at or above 16", () => {
      const body = {
        model: "gpt-5.4-mini",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 16,
      };

      const result = openaiToOpenAIResponsesRequest("gpt-5.4-mini", body, true, null);

      expect(result.max_output_tokens).toBe(16);
    });
  });

  describe("Responses API → Chat Completions (openaiResponsesToOpenAIRequest)", () => {
    it("maps max_output_tokens → max_tokens", () => {
      const body = {
        model: "gpt-5.4-mini",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
        max_output_tokens: 256,
      };

      const result = openaiResponsesToOpenAIRequest("gpt-5.4-mini", body, false, null);

      expect(result.max_tokens).toBe(256);
      expect(result.max_output_tokens).toBeUndefined();
    });

    it("drops max_output_tokens entirely when not set (no stray field on upstream)", () => {
      const body = {
        model: "gpt-5.4-mini",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      };

      const result = openaiResponsesToOpenAIRequest("gpt-5.4-mini", body, false, null);

      expect(result.max_output_tokens).toBeUndefined();
      expect(result.max_tokens).toBeUndefined();
    });
  });
});
