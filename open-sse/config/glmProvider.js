import { ANTHROPIC_VERSION_HEADER } from "./anthropicHeaders";
export const GLM_DEFAULT_BASE_URLS = Object.freeze({
  international: "https://api.z.ai/api/coding/paas/v4/chat/completions",
  china: "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions"
});
export const GLM_ANTHROPIC_DEFAULT_BASE_URLS = Object.freeze({
  international: "https://api.z.ai/api/anthropic/v1/messages",
  china: "https://open.bigmodel.cn/api/anthropic/v1/messages"
});
export const GLM_SHARED_MODELS = Object.freeze([{
  id: "glm-5.2",
  name: "GLM 5.2",
  contextLength: 1000000,
  maxOutputTokens: 131072,
  toolCalling: true,
  supportsReasoning: true
}, {
  id: "glm-5.2-high",
  name: "GLM 5.2 High",
  contextLength: 1000000,
  maxOutputTokens: 131072,
  toolCalling: true,
  supportsReasoning: true
}, {
  id: "glm-5.2-max",
  name: "GLM 5.2 Max",
  contextLength: 1000000,
  maxOutputTokens: 131072,
  toolCalling: true,
  supportsReasoning: true
}, {
  id: "glm-5.1",
  name: "GLM 5.1",
  contextLength: 204800,
  maxOutputTokens: 131072,
  toolCalling: true,
  supportsReasoning: true
}, {
  id: "glm-5",
  name: "GLM 5",
  contextLength: 200000,
  maxOutputTokens: 131072,
  toolCalling: true,
  supportsReasoning: true
}, {
  id: "glm-5-turbo",
  name: "GLM 5 Turbo",
  contextLength: 200000,
  maxOutputTokens: 131072,
  toolCalling: true,
  supportsReasoning: true
}, {
  id: "glm-4.7-flash",
  name: "GLM 4.7 Flash",
  contextLength: 200000,
  maxOutputTokens: 131072,
  toolCalling: true,
  supportsReasoning: true
}, {
  id: "glm-4.7",
  name: "GLM 4.7",
  contextLength: 200000,
  maxOutputTokens: 131072,
  toolCalling: true,
  supportsReasoning: true
}, {
  id: "glm-4.6v",
  name: "GLM 4.6V (Vision)",
  contextLength: 128000,
  maxOutputTokens: 32768,
  toolCalling: true,
  supportsReasoning: true,
  supportsVision: true
}, {
  id: "glm-4.6",
  name: "GLM 4.6",
  contextLength: 200000,
  maxOutputTokens: 32768,
  toolCalling: true,
  supportsReasoning: true
}, {
  id: "glm-4.5v",
  name: "GLM 4.5V (Vision)",
  contextLength: 16000,
  maxOutputTokens: 32768,
  toolCalling: true,
  supportsReasoning: true,
  supportsVision: true
}, {
  id: "glm-4.5",
  name: "GLM 4.5",
  contextLength: 128000,
  maxOutputTokens: 32768,
  toolCalling: true,
  supportsReasoning: true
}, {
  id: "glm-4.5-air",
  name: "GLM 4.5 Air",
  contextLength: 128000,
  maxOutputTokens: 32768,
  toolCalling: true,
  supportsReasoning: true
}]);
export const GLM_MODELS_URLS = Object.freeze({
  international: "https://api.z.ai/api/coding/paas/v4/models",
  china: "https://open.bigmodel.cn/api/coding/paas/v4/models"
});
export const GLM_QUOTA_URLS = Object.freeze({
  international: "https://api.z.ai/api/monitor/usage/quota/limit",
  china: "https://open.bigmodel.cn/api/monitor/usage/quota/limit"
});
export const GLMT_TIMEOUT_MS = 900_000;
export const GLM_TIMEOUT_MS = 3_000_000; // 50 min — aligned with Z.AI Coding Plan FAQ (API_TIMEOUT_MS=3000000)

export const GLM_REQUEST_DEFAULTS = Object.freeze({
  maxTokens: 16_384
});
export const GLMT_REQUEST_DEFAULTS = Object.freeze({
  maxTokens: 65_536,
  temperature: 0.2,
  thinkingBudgetTokens: 24_576,
  thinkingType: "adaptive"
});
export const GLM_COUNT_TOKENS_TIMEOUT_MS = 3_000;
export const GLM_CLAUDE_CODE_USER_AGENT = "claude-cli/2.1.195 (external, sdk-cli)";
export const GLM_ANTHROPIC_BETA = ["claude-code-20250219", "interleaved-thinking-2025-05-14", "context-management-2025-06-27", "prompt-caching-scope-2026-01-05", "advisor-tool-2026-03-01", "effort-2025-11-24"].join(",");
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function asString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function splitUrlQueryAndHash(url) {
  const idx = url.search(/[?#]/);
  if (idx === -1) return {
    base: url,
    suffix: ""
  };
  return {
    base: url.substring(0, idx),
    suffix: url.substring(idx)
  };
}
export function getGlmApiRegion(providerSpecificData) {
  const data = asRecord(providerSpecificData);
  return data.apiRegion === "china" ? "china" : "international";
}
export function buildGlmModelsUrl(providerSpecificData, transport = "openai", fallbackBaseUrl) {
  const data = asRecord(providerSpecificData);
  const customModelsUrl = asString(data.modelsUrl);
  if (customModelsUrl) return customModelsUrl;
  if (transport === "anthropic") {
    return joinGlmBaseAndPath(getGlmAnthropicBaseUrl(providerSpecificData, fallbackBaseUrl), "/v1/models");
  }
  const configuredBaseUrl = asString(data.baseUrl);
  if (configuredBaseUrl) {
    if (isAnthropicGlmBaseUrl(configuredBaseUrl)) {
      return GLM_MODELS_URLS[getGlmApiRegion(providerSpecificData)];
    }
    return joinGlmBaseAndPath(configuredBaseUrl, "/models");
  }
  return GLM_MODELS_URLS[getGlmApiRegion(providerSpecificData)];
}
export function getGlmQuotaUrl(providerSpecificData) {
  return GLM_QUOTA_URLS[getGlmApiRegion(providerSpecificData)];
}
function stripKnownGlmEndpointSuffix(baseUrl) {
  const parts = splitUrlQueryAndHash(baseUrl);
  let base = parts.base;
  while (base.endsWith("/")) {
    base = base.slice(0, -1);
  }
  const countTokensMatch = base.match(/\/(?:v\d+\/)?messages\/count_tokens$/i);
  if (countTokensMatch) {
    base = base.substring(0, base.length - countTokensMatch[0].length);
  } else {
    const messagesMatch = base.match(/\/(?:v\d+\/)?messages$/i);
    if (messagesMatch) {
      base = base.substring(0, base.length - messagesMatch[0].length);
    } else if (base.toLowerCase().endsWith("/chat/completions")) {
      base = base.substring(0, base.length - "/chat/completions".length);
    } else if (base.toLowerCase().endsWith("/models")) {
      base = base.substring(0, base.length - "/models".length);
    }
  }
  return {
    base,
    suffix: parts.suffix
  };
}
function joinGlmBaseAndPath(baseUrl, path) {
  const {
    base,
    suffix
  } = stripKnownGlmEndpointSuffix(baseUrl);
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const versionMatch = base.match(/\/v\d+$/i);
  if (versionMatch && normalizedPath.toLowerCase().startsWith(`${versionMatch[0].toLowerCase()}/`)) {
    return `${base}${normalizedPath.slice(versionMatch[0].length)}${suffix}`;
  }
  return `${base}${normalizedPath}${suffix}`;
}
function stripQueryAndTrailingSlash(baseUrl) {
  let base = splitUrlQueryAndHash(baseUrl).base;
  while (base.endsWith("/")) {
    base = base.slice(0, -1);
  }
  return base;
}
function addBetaQuery(url) {
  const parsed = new URL(url);
  parsed.searchParams.set("beta", "true");
  return parsed.toString();
}
export function isAnthropicGlmBaseUrl(baseUrl) {
  const base = stripQueryAndTrailingSlash(baseUrl).toLowerCase();
  return base.includes("/api/anthropic/") || base.endsWith("/api/anthropic");
}
export function isCodingGlmBaseUrl(baseUrl) {
  const base = stripQueryAndTrailingSlash(baseUrl).toLowerCase();
  const idx = base.indexOf("/api/coding/paas/v");
  if (idx === -1) return false;
  const afterV = base.charCodeAt(idx + "/api/coding/paas/v".length);
  return afterV >= 48 && afterV <= 57; // first char after 'v' must be a digit
}
export function getGlmBaseUrl(providerSpecificData, fallbackBaseUrl) {
  const data = asRecord(providerSpecificData);
  const configuredBaseUrl = asString(data.baseUrl);
  if (configuredBaseUrl) return configuredBaseUrl;
  const regionalBaseUrl = typeof fallbackBaseUrl === "string" && fallbackBaseUrl.trim() && isCodingGlmBaseUrl(fallbackBaseUrl) ? fallbackBaseUrl.trim() : GLM_DEFAULT_BASE_URLS[getGlmApiRegion(providerSpecificData)];
  if (regionalBaseUrl) return regionalBaseUrl;
  return typeof fallbackBaseUrl === "string" && fallbackBaseUrl.trim() ? fallbackBaseUrl.trim() : GLM_DEFAULT_BASE_URLS.international;
}
export function getGlmAnthropicBaseUrl(providerSpecificData, fallbackBaseUrl) {
  const data = asRecord(providerSpecificData);
  const anthropicBaseUrl = asString(data.anthropicBaseUrl);
  if (anthropicBaseUrl) return anthropicBaseUrl;
  const configuredBaseUrl = asString(data.baseUrl);
  if (configuredBaseUrl) {
    if (isCodingGlmBaseUrl(configuredBaseUrl)) {
      return GLM_ANTHROPIC_DEFAULT_BASE_URLS[getGlmApiRegion(providerSpecificData)];
    }
    return configuredBaseUrl;
  }
  if (typeof fallbackBaseUrl === "string" && fallbackBaseUrl.trim() && isCodingGlmBaseUrl(fallbackBaseUrl)) {
    return GLM_ANTHROPIC_DEFAULT_BASE_URLS[fallbackBaseUrl.includes("open.bigmodel.cn") ? "china" : getGlmApiRegion(providerSpecificData)];
  }
  if (typeof fallbackBaseUrl === "string" && fallbackBaseUrl.trim() && !isCodingGlmBaseUrl(fallbackBaseUrl)) {
    return fallbackBaseUrl.trim();
  }
  return GLM_ANTHROPIC_DEFAULT_BASE_URLS[getGlmApiRegion(providerSpecificData)];
}
export function getGlmPrimaryTransport(providerSpecificData, fallbackBaseUrl) {
  const data = asRecord(providerSpecificData);
  const configuredTransport = asString(data.primaryTransport);
  if (configuredTransport === "anthropic") return "anthropic";
  if (configuredTransport === "openai") return "openai";
  return isAnthropicGlmBaseUrl(getGlmBaseUrl(providerSpecificData, fallbackBaseUrl)) ? "anthropic" : "openai";
}
export function getGlmTransport(providerSpecificData, fallbackBaseUrl) {
  return getGlmPrimaryTransport(providerSpecificData, fallbackBaseUrl);
}
export function buildGlmChatUrl(providerSpecificData, transport = "openai", fallbackBaseUrl) {
  if (transport === "anthropic") {
    return buildGlmAnthropicMessagesUrl(providerSpecificData, fallbackBaseUrl);
  }
  return buildGlmOpenAIChatUrl(providerSpecificData, fallbackBaseUrl);
}
export function buildGlmOpenAIChatUrl(providerSpecificData, fallbackBaseUrl) {
  const configuredBaseUrl = getGlmBaseUrl(providerSpecificData, fallbackBaseUrl);
  const baseUrl = isAnthropicGlmBaseUrl(configuredBaseUrl) ? GLM_DEFAULT_BASE_URLS[getGlmApiRegion(providerSpecificData)] : configuredBaseUrl;
  return joinGlmBaseAndPath(baseUrl, "/chat/completions");
}
export function buildGlmAnthropicMessagesUrl(providerSpecificData, fallbackBaseUrl) {
  return addBetaQuery(joinGlmBaseAndPath(getGlmAnthropicBaseUrl(providerSpecificData, fallbackBaseUrl), "/v1/messages"));
}
export function buildGlmCountTokensUrl(providerSpecificData, fallbackBaseUrl) {
  return addBetaQuery(joinGlmBaseAndPath(getGlmAnthropicBaseUrl(providerSpecificData, fallbackBaseUrl), "/v1/messages/count_tokens"));
}
export function buildGlmCodingHeaders(apiKey, stream = true) {
  return {
    "Content-Type": "application/json",
    Accept: stream ? "text/event-stream" : "application/json",
    Authorization: `Bearer ${apiKey}`
  };
}
export function buildGlmBaseHeaders(apiKey, stream = true) {
  return {
    "Content-Type": "application/json",
    Accept: stream ? "text/event-stream" : "application/json",
    "x-api-key": apiKey,
    "anthropic-version": ANTHROPIC_VERSION_HEADER,
    "anthropic-beta": GLM_ANTHROPIC_BETA,
    "anthropic-dangerous-direct-browser-access": "true",
    "User-Agent": GLM_CLAUDE_CODE_USER_AGENT,
    "X-Stainless-Lang": "js",
    "X-Stainless-Runtime": "node",
    "X-Stainless-Retry-Count": "0",
    "accept-language": "*",
    "accept-encoding": "gzip, deflate, br, zstd",
    connection: "keep-alive"
  };
}