import { randomUUID } from "node:crypto";
import { DefaultExecutor } from "./default";
import { applyConfiguredUserAgent, mergeAbortSignals, mergeUpstreamExtraHeaders } from "./base";
import { buildGlmBaseHeaders, buildGlmChatUrl, buildGlmCodingHeaders, buildGlmCountTokensUrl, GLM_COUNT_TOKENS_TIMEOUT_MS, getGlmTransport } from "../config/glmProvider";
import { applyProviderRequestDefaults } from "../services/providerRequestDefaults";
import { getRotatingApiKey } from "../services/apiKeyRotator";
import { CLAUDE_CLI_STAINLESS_PACKAGE_VERSION } from "../config/anthropicHeaders";
import { getRuntimeVersion, normalizeStainlessArch, normalizeStainlessPlatform } from "../config/providerHeaderProfiles";
import { translateNonStreamingResponse } from "../handlers/responseTranslator";
import { translateRequest } from "../translator/index";
import { FORMATS } from "../translator/formats";
import { createSSETransformStreamWithLogger } from "../utils/stream";
import { ensureStreamReadiness } from "../utils/streamReadiness";
import { STREAM_READINESS_TIMEOUT_MS } from "../config/constants";
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function getEffectiveKey(credentials) {
  const extraKeys = credentials.providerSpecificData?.extraApiKeys ?? [];
  if (credentials.apiKey && credentials.connectionId && extraKeys.length > 0) {
    return getRotatingApiKey(credentials.connectionId, credentials.apiKey, extraKeys);
  }
  return credentials.apiKey || credentials.accessToken || "";
}

/**
 * GLM-5.2 effort tiers route exclusively through the Anthropic transport,
 * where Zhipu maps Claude Code effort selectors (high/max) to reasoning
 * intensity. The base model ID sent upstream is always "glm-5.2".
 *
 * https://docs.z.ai/devpack/latest-model
 */
function parseGlm52Effort(model) {
  if (model === "glm-5.2-high") return {
    baseModel: "glm-5.2",
    effort: "high"
  };
  if (model === "glm-5.2-max") return {
    baseModel: "glm-5.2",
    effort: "max"
  };
  return null;
}

/**
 * Detects GLM models that support deep thinking (5.2+).
 * These models share a single max_tokens budget for reasoning + response
 * (Z.AI does not document a separate thinking budget). When the client
 * doesn't explicitly request max_tokens, we default to the model's full
 * output capacity so reasoning isn't truncated by a low generic default.
 *
 * To add future models (e.g. glm-5.3, glm-5.4), just extend the regex.
 * https://docs.z.ai/guides/overview/concept-param
 */
const GLM_THINKING_MODEL_PATTERN = /^glm-5\.(?:[2-9]|\d{2,})/i;
function isGlmThinkingModel(model) {
  return GLM_THINKING_MODEL_PATTERN.test(model);
}

/**
 * Z.AI's official max output for GLM-5.2+ is 131072 tokens (128K).
 * This budget covers BOTH reasoning and the final response.
 * https://z.ai/blog/glm-5.2
 */
const GLM_THINKING_DEFAULT_MAX_TOKENS = 131072;
function applyGlmRequestDefaults(body, defaults) {
  const record = asRecord(body);
  if (!record || !defaults) return body;
  const next = {
    ...applyProviderRequestDefaults(record, defaults)
  };
  const thinkingType = typeof defaults.thinkingType === "string" ? defaults.thinkingType : null;
  if (thinkingType && next.thinking === undefined) {
    next.thinking = {
      type: thinkingType
    };
  } else if (thinkingType && asRecord(next.thinking)?.type === "enabled") {
    next.thinking = {
      ...asRecord(next.thinking),
      type: thinkingType
    };
  }
  return next;
}
function hasTools(body) {
  const record = asRecord(body);
  return Array.isArray(record?.tools) && record.tools.length > 0;
}
function isRetryableGlmFallbackStatus(status) {
  return status === 404 || status === 408 || status === 409 || status === 429 || status >= 500;
}
function isRetryableGlmFallbackError(error) {
  if (!error) return false;
  const err = error instanceof Error ? error : new Error(String(error));
  if (err.name === "AbortError") return false;
  return true;
}
function cloneHeaders(headers) {
  const next = new Headers();
  headers.forEach((value, key) => next.set(key, value));
  return next;
}
function isJsonResponse(response) {
  return (response.headers.get("content-type") || "").toLowerCase().includes("application/json");
}
async function translateJsonResponse(response) {
  const parsed = await response.json().catch(() => null);
  const translated = translateNonStreamingResponse(parsed, FORMATS.CLAUDE, FORMATS.OPENAI);
  const headers = cloneHeaders(response.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  return new Response(JSON.stringify(translated), {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
async function translateAnthropicJsonResponse(response) {
  const parsed = await response.json().catch(() => null);
  const translated = response.ok ? translateNonStreamingResponse(parsed, FORMATS.CLAUDE, FORMATS.OPENAI) : translateAnthropicJsonError(parsed);
  const headers = cloneHeaders(response.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  return new Response(JSON.stringify(translated), {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
function translateAnthropicJsonError(parsed) {
  const root = asRecord(parsed) || {};
  const error = asRecord(root.error) || root;
  const message = typeof error.message === "string" && error.message.trim() ? error.message : typeof root.message === "string" && root.message.trim() ? root.message : "GLM Anthropic transport error";
  const type = typeof error.type === "string" && error.type.trim() ? error.type : typeof root.type === "string" && root.type.trim() ? root.type : "upstream_error";
  return {
    error: {
      message,
      type
    }
  };
}
function translateSseResponse(response, provider, model) {
  if (!response.body) return response;
  const transform = createSSETransformStreamWithLogger(FORMATS.CLAUDE, FORMATS.OPENAI, provider, null, null, model);
  const headers = cloneHeaders(response.headers);
  headers.set("content-type", "text/event-stream");
  headers.delete("content-length");
  return new Response(response.body.pipeThrough(transform), {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
export class GlmExecutor extends DefaultExecutor {
  constructor(provider = "glm") {
    super(provider);
  }
  buildUrl(_model, _stream, _urlIndex = 0, credentials = null) {
    const primaryTransport = getGlmTransport(credentials?.providerSpecificData);
    const transport = _urlIndex === 1 ? primaryTransport === "openai" ? "anthropic" : "openai" : primaryTransport;
    return buildGlmChatUrl(credentials?.providerSpecificData, transport, this.config.baseUrl);
  }
  buildCountTokensUrl(_model, credentials = null) {
    return buildGlmCountTokensUrl(credentials?.providerSpecificData, this.config.baseUrl);
  }
  getCountTokensTimeoutMs() {
    return GLM_COUNT_TOKENS_TIMEOUT_MS;
  }
  buildHeaders(credentials, stream = true, _clientHeaders, _model, transport = getGlmTransport(credentials.providerSpecificData)) {
    if (transport === "openai") {
      return buildGlmCodingHeaders(getEffectiveKey(credentials), stream);
    }
    return {
      ...buildGlmBaseHeaders(getEffectiveKey(credentials), stream),
      "X-Stainless-Arch": normalizeStainlessArch(),
      "X-Stainless-OS": normalizeStainlessPlatform(),
      "X-Stainless-Runtime-Version": getRuntimeVersion(),
      "X-Stainless-Package-Version": CLAUDE_CLI_STAINLESS_PACKAGE_VERSION,
      "X-Claude-Code-Session-Id": randomUUID(),
      "x-client-request-id": randomUUID()
    };
  }
  transformRequest(model, body, stream, credentials) {
    const cleanedBody = super.transformRequest(model, body, stream, credentials);
    return applyGlmRequestDefaults(cleanedBody, this.config.requestDefaults);
  }
  transformForTransport(model, body, stream, credentials, transport) {
    const effortTier = parseGlm52Effort(model);
    const effectiveModel = effortTier ? effortTier.baseModel : model;
    const transformed = this.transformRequest(effectiveModel, body, stream, credentials);
    const record = asRecord(transformed);

    // Ensure upstream receives the base model ID, not the effort-suffixed alias
    if (record && effortTier) {
      record.model = effectiveModel;
    }

    // GLM-5.2+ models share a single max_tokens budget for reasoning + response.
    // When the client doesn't explicitly set max_tokens, default to the model's
    // full output capacity (131072) so deep reasoning isn't truncated by the
    // generic translator defaults (64000 for Anthropic, 16384 for OpenAI).
    // This acts as the "transparent proxy override" described in Z.AI's own
    // Terminal-Bench evaluation methodology.
    // https://huggingface.co/blog/zai-org/glm-52-blog
    if (record && isGlmThinkingModel(effectiveModel)) {
      const clientBody = asRecord(body);
      const clientMaxTokens = clientBody?.max_tokens ?? clientBody?.max_completion_tokens;
      if (!clientMaxTokens) {
        record.max_tokens = GLM_THINKING_DEFAULT_MAX_TOKENS;
      }
    }
    if (transport === "openai") {
      if (record && stream && hasTools(record) && record.tool_stream === undefined) {
        return {
          ...record,
          tool_stream: true
        };
      }
      return transformed;
    }
    const translated = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, effectiveModel, {
      ...(record ?? {}),
      _disableToolPrefix: true
    }, stream, credentials, this.provider, null, {
      preserveCacheControl: false
    });

    // Inject effort and thinking for the Anthropic transport.
    // Zhipu's Anthropic endpoint requires thinking.type=enabled to emit
    // thinking_delta blocks in the SSE response. Without it, reasoning is
    // not surfaced and clients see no thinking content.
    // The effort-2025-11-24 beta header (in GLM_ANTHROPIC_BETA) carries
    // the high/max intensity selector.
    if (effortTier) {
      const translatedRecord = asRecord(translated);
      if (translatedRecord) {
        translatedRecord.effort = effortTier.effort;
        // Zhipu's Anthropic endpoint only supports thinking.type
        // "enabled"/"disabled" — not "adaptive". Clients like Claude Code
        // default to "adaptive" for reasoning models, so force "enabled"
        // here while preserving any other fields (e.g. budget_tokens).
        const existingThinking = asRecord(translatedRecord.thinking);
        if (!existingThinking || existingThinking.type !== "enabled") {
          translatedRecord.thinking = {
            ...existingThinking,
            type: "enabled"
          };
        }
      }
    }
    return translated;
  }
  async executeTransport(input, transport) {
    const credentials = input.credentials;
    const url = buildGlmChatUrl(credentials?.providerSpecificData, transport, this.config.baseUrl);
    const headers = this.buildHeaders(credentials, input.stream, input.clientHeaders, input.model, transport);
    applyConfiguredUserAgent(headers, credentials.providerSpecificData);
    mergeUpstreamExtraHeaders(headers, input.upstreamExtraHeaders);
    const transformedBody = this.transformForTransport(input.model, input.body, input.stream, credentials, transport);
    const fetchStartTimeoutMs = this.getTimeoutMs();
    const timeoutController = fetchStartTimeoutMs > 0 ? new AbortController() : null;
    let timeoutId = null;
    if (timeoutController) {
      timeoutId = setTimeout(() => {
        const timeoutError = new Error(`Fetch timeout after ${fetchStartTimeoutMs}ms on ${url}`);
        timeoutError.name = "TimeoutError";
        timeoutController.abort(timeoutError);
      }, fetchStartTimeoutMs);
    }
    const timeoutSignal = timeoutController?.signal ?? null;
    const combinedSignal = input.signal && timeoutSignal ? mergeAbortSignals(input.signal, timeoutSignal) : input.signal || timeoutSignal;
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(transformedBody),
        signal: combinedSignal || undefined
      });
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
    if (input.stream && response.ok) {
      const readiness = await ensureStreamReadiness(response, {
        timeoutMs: STREAM_READINESS_TIMEOUT_MS,
        provider: this.provider,
        model: input.model,
        log: input.log
      });
      response = readiness.response;
    }
    const result = {
      response,
      url,
      headers,
      transformedBody
    };
    if (transport === "anthropic") {
      const translatedResponse = input.stream && result.response.ok ? translateSseResponse(result.response, this.provider, input.model) : isJsonResponse(result.response) ? await translateAnthropicJsonResponse(result.response) : result.response;
      return {
        ...result,
        response: translatedResponse,
        url,
        headers,
        transformedBody,
        targetFormat: FORMATS.OPENAI
      };
    }
    return {
      ...result,
      url,
      headers,
      transformedBody,
      targetFormat: FORMATS.OPENAI
    };
  }
  async execute(input) {
    const effortTier = parseGlm52Effort(input.model);

    // GLM-5.2 effort tiers route directly through Anthropic transport (no fallback).
    // Zhipu only graduates effort on the Anthropic endpoint via the
    // effort-2025-11-24 beta header included in GLM_ANTHROPIC_BETA.
    if (effortTier) {
      return this.executeTransport(input, "anthropic");
    }
    const primaryTransport = getGlmTransport(input.credentials.providerSpecificData, this.config.baseUrl);
    const fallbackTransport = primaryTransport === "openai" ? "anthropic" : "openai";
    let primaryResult = null;
    try {
      primaryResult = await this.executeTransport(input, primaryTransport);
      if (!isRetryableGlmFallbackStatus(primaryResult.response.status)) {
        return primaryResult;
      }
      input.log?.debug?.("GLM_FALLBACK", `${primaryTransport} returned ${primaryResult.response.status}; trying ${fallbackTransport}`);
    } catch (error) {
      if (!isRetryableGlmFallbackError(error)) throw error;
      input.log?.debug?.("GLM_FALLBACK", `${primaryTransport} error (${error instanceof Error ? error.message : String(error)}); trying ${fallbackTransport}`);
    }
    try {
      const fallbackResult = await this.executeTransport(input, fallbackTransport);
      if (fallbackResult.response.ok || !primaryResult) {
        return fallbackResult;
      }
    } catch (error) {
      if (!primaryResult) throw error;
      input.log?.debug?.("GLM_FALLBACK", `${fallbackTransport} fallback failed (${error instanceof Error ? error.message : String(error)}); returning primary response`);
    }
    return primaryResult;
  }
  async countTokens(input) {
    return super.countTokens({
      ...input,
      credentials: {
        ...input.credentials,
        providerSpecificData: {
          ...(input.credentials.providerSpecificData || {}),
          primaryTransport: "anthropic"
        }
      }
    });
  }
}
export default GlmExecutor;