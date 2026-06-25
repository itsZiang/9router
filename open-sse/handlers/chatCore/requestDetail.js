import { saveRequestUsage, appendRequestLog, saveRequestDetail } from "@/lib/usageDb.js";
import { COLORS } from "../../utils/stream.js";

const OPTIONAL_PARAMS = [
  "temperature", "top_p", "top_k",
  "max_tokens", "max_completion_tokens",
  "thinking", "reasoning", "enable_thinking",
  "presence_penalty", "frequency_penalty",
  "seed", "stop", "tools", "tool_choice",
  "response_format", "prediction", "store", "metadata",
  "n", "logprobs", "top_logprobs", "logit_bias",
  "user", "parallel_tool_calls"
];

export function extractRequestConfig(body, stream) {
  const config = { messages: body.messages || [], model: body.model, stream };
  for (const param of OPTIONAL_PARAMS) {
    if (body[param] !== undefined) config[param] = body[param];
  }
  return config;
}

export function extractUsageFromResponse(responseBody) {
  if (!responseBody || typeof responseBody !== "object") return null;

  // Claude format (also covers OpenAI Responses API: input_tokens / output_tokens)
  if (responseBody.usage?.input_tokens !== undefined) {
    return {
      prompt_tokens: responseBody.usage.input_tokens || 0,
      completion_tokens: responseBody.usage.output_tokens || 0,
      total_tokens: responseBody.usage.total_tokens,
      cached_tokens: responseBody.usage.input_tokens_details?.cached_tokens,
      reasoning_tokens: responseBody.usage.output_tokens_details?.reasoning_tokens,
      cache_read_input_tokens: responseBody.usage.cache_read_input_tokens,
      cache_creation_input_tokens: responseBody.usage.cache_creation_input_tokens
    };
  }

  // OpenAI Chat Completions format
  if (responseBody.usage?.prompt_tokens !== undefined) {
    return {
      prompt_tokens: responseBody.usage.prompt_tokens || 0,
      completion_tokens: responseBody.usage.completion_tokens || 0,
      cached_tokens: responseBody.usage.prompt_tokens_details?.cached_tokens,
      reasoning_tokens: responseBody.usage.completion_tokens_details?.reasoning_tokens
    };
  }

  // Gemini / Vertex format (also Antigravity wraps under responseBody.response)
  const usageMeta = responseBody.usageMetadata || responseBody.response?.usageMetadata;
  if (usageMeta) {
    return {
      prompt_tokens: usageMeta.promptTokenCount || 0,
      completion_tokens: usageMeta.candidatesTokenCount || 0,
      reasoning_tokens: usageMeta.thoughtsTokenCount
    };
  }

  // Ollama format (raw provider response before translation)
  if (responseBody.done === true && typeof responseBody.prompt_eval_count === "number") {
    return {
      prompt_tokens: responseBody.prompt_eval_count || 0,
      completion_tokens: responseBody.eval_count || 0
    };
  }

  return null;
}

export function buildRequestDetail(base, overrides = {}) {
  return {
    provider: base.provider || "unknown",
    model: base.model || "unknown",
    connectionId: base.connectionId || undefined,
    timestamp: new Date().toISOString(),
    latency: base.latency || { ttft: 0, total: 0 },
    tokens: base.tokens || { prompt_tokens: 0, completion_tokens: 0 },
    request: base.request,
    providerRequest: base.providerRequest || null,
    providerResponse: base.providerResponse || null,
    response: base.response || {},
    status: base.status || "success",
    ...overrides
  };
}

export function saveUsageStats({ provider, model, tokens, connectionId, apiKey, endpoint, label = "USAGE" }) {
  if (!tokens || typeof tokens !== "object") {
    console.log(`[${label}] SKIP: tokens is null or not an object`);
    return;
  }

  const inTokens = tokens.input_tokens ?? tokens.prompt_tokens ?? 0;
  const outTokens = tokens.output_tokens ?? tokens.completion_tokens ?? 0;

  if (inTokens === 0 && outTokens === 0) {
    console.log(`[${label}] SKIP: both input and output tokens are 0`, tokens);
    return;
  }

  const _u = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const time = `${String(_u.getUTCHours()).padStart(2,"0")}:${String(_u.getUTCMinutes()).padStart(2,"0")}:${String(_u.getUTCSeconds()).padStart(2,"0")}`;
  const accountSuffix = connectionId ? ` | account=${connectionId.slice(0, 8)}...` : "";
  console.log(`${COLORS.green}[${time}] 📊 [${label}] ${provider?.toUpperCase() || "UNKNOWN"} | in=${inTokens} | out=${outTokens}${accountSuffix}${COLORS.reset}`);

  // Normalize to OpenAI token shape for storage
  const normalized = {
    prompt_tokens: tokens.prompt_tokens ?? tokens.input_tokens ?? 0,
    completion_tokens: tokens.completion_tokens ?? tokens.output_tokens ?? 0
  };

  saveRequestUsage({
    provider: provider || "unknown",
    model: model || "unknown",
    tokens: normalized,
    timestamp: new Date().toISOString(),
    connectionId: connectionId || undefined,
    apiKey: apiKey || undefined,
    endpoint: endpoint || null
  }).catch((e) => {
    console.error(`[${label}] saveRequestUsage failed:`, e?.message || e);
  });
}
