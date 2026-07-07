// Regression tests for the false-502 bug: a reasoning-only completion truncated at
// max_tokens (content:null, finish_reason:"length", reasoning carried in `reasoning`
// /`reasoning_details`) is a VALID 200, not a malformed empty response.
//
// Repro (OpenRouter Cohere/North free-tier): the model streams reasoning, hits
// max_tokens before emitting visible text, and returns:
//   choices:[{ finish_reason:"length", message:{ content:null,
//     reasoning:"The user just says \"hi\"...", reasoning_details:[{type:"reasoning.text",...}] }}]
// Both detectors must accept this as usable output (or a legit truncation), never
// flag it as empty_choices → false 502.
import { describe, it, expect } from "vitest";
import { detectMalformedNonStream } from "../../open-sse/utils/diagnostics.js";
import { isEmptyContentResponse } from "../../open-sse/services/errorClassifier.js";

const COHERE_TRUNCATED_BODY = {
  id: "gen-1783451419-kU6GtXGfOc5Fa1mcj5s6",
  object: "chat.completion",
  created: 1783451419,
  model: "cohere/north-mini-code-20260617:free",
  provider: "Cohere",
  choices: [{
    index: 0,
    logprobs: null,
    finish_reason: "length",
    native_finish_reason: "max_tokens",
    message: {
      role: "assistant",
      content: null,
      refusal: null,
      reasoning: "The user just says \"hi\". We need to respond friendly. Likely a casual",
      reasoning_details: [{ type: "reasoning.text", text: "The user just says \"hi\"...", format: "unknown" }]
    }
  }],
  usage: { prompt_tokens: 10, completion_tokens: 5 }
};

describe("reasoning-only truncated completion is NOT malformed", () => {
  it("detectMalformedNonStream accepts Cohere reasoning-then-length body (reasoning field)", () => {
    expect(detectMalformedNonStream(COHERE_TRUNCATED_BODY)).toBeNull();
  });

  it("isEmptyContentResponse does not flag reasoning-then-length body as empty", () => {
    expect(isEmptyContentResponse(COHERE_TRUNCATED_BODY)).toBe(false);
  });

  it("detectMalformedNonStream honors reasoning_content alias too", () => {
    expect(detectMalformedNonStream({
      choices: [{ finish_reason: "stop", message: { content: null, reasoning_content: "thinking..." } }]
    })).toBeNull();
  });

  it("detectMalformedNonStream honors reasoning_details text blocks", () => {
    expect(detectMalformedNonStream({
      choices: [{ finish_reason: "stop", message: { content: null, reasoning_details: [{ type: "reasoning.text", text: "thoughts" }] } }]
    })).toBeNull();
  });

  it("finish_reason length alone (no reasoning, no content) is a legit truncation, not malformed", () => {
    expect(detectMalformedNonStream({
      choices: [{ finish_reason: "length", message: { content: null } }]
    })).toBeNull();
  });

  it("genuinely empty response (no choices, no content, no finish_reason) is still flagged", () => {
    expect(detectMalformedNonStream({ id: "x", usage: {} })).toBe("empty_choices");
    expect(detectMalformedNonStream({
      choices: [{ finish_reason: "stop", message: { content: null } }]
    })).toBe("empty_choices");
  });
});
