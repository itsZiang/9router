import { stripTrailingSlashes, normalizeBaseUrl } from "../utils/urlSanitize";
export const AZURE_AI_DEFAULT_BASE_URL = "https://example-resource.services.ai.azure.com/openai/v1";
export function normalizeAzureAiBaseUrl(value) {
  const normalized = normalizeBaseUrl(value || AZURE_AI_DEFAULT_BASE_URL);
  if (!normalized) return AZURE_AI_DEFAULT_BASE_URL;
  if (normalized.endsWith("/chat/completions") || normalized.endsWith("/responses") || normalized.endsWith("/models")) {
    return normalized.replace(/\/(?:chat\/completions|responses|models)$/i, "");
  }
  if (normalized.endsWith("/openai/v1") || normalized.endsWith("/v1")) {
    return normalized;
  }
  if (normalized.endsWith("/openai")) {
    return `${normalized}/v1`;
  }
  const parsed = new URL(normalized);
  if (parsed.hostname.endsWith(".services.ai.azure.com") || parsed.hostname.endsWith(".openai.azure.com")) {
    if (!parsed.pathname || parsed.pathname === "/") {
      parsed.pathname = "/openai/v1";
      return stripTrailingSlashes(parsed.toString());
    }
  }
  return normalized;
}
export function buildAzureAiChatUrl(value, apiType = "chat") {
  const normalized = normalizeAzureAiBaseUrl(value);
  return `${normalized}/${apiType === "responses" ? "responses" : "chat/completions"}`;
}
export function buildAzureAiModelsUrl(value) {
  return `${normalizeAzureAiBaseUrl(value)}/models`;
}