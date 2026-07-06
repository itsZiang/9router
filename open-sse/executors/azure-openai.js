import { DefaultExecutor } from "./default";
import { stripTrailingSlashes } from "../utils/urlSanitize";
const DEFAULT_API_VERSION = "2024-12-01-preview";
function normalizeAzureBaseUrl(rawBaseUrl) {
  const normalized = stripTrailingSlashes((rawBaseUrl || "").trim());
  if (!normalized) return "";
  return normalized.replace(/\/openai$/i, "").replace(/\/openai\/deployments\/[^/]+\/chat\/completions[^/]*$/i, "");
}
export class AzureOpenAIExecutor extends DefaultExecutor {
  constructor() {
    super("azure-openai");
  }
  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    void urlIndex;
    const providerSpecificData = credentials?.providerSpecificData || {};
    const baseUrl = normalizeAzureBaseUrl(providerSpecificData.baseUrl || this.config.baseUrl);
    const apiVersion = typeof providerSpecificData.apiVersion === "string" && providerSpecificData.apiVersion.trim() ? providerSpecificData.apiVersion.trim() : DEFAULT_API_VERSION;
    return `${baseUrl}/openai/deployments/${encodeURIComponent(model)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;
  }
  buildHeaders(credentials, stream = true) {
    const apiKey = credentials?.apiKey || credentials?.accessToken || "";
    const headers = {
      "Content-Type": "application/json",
      "api-key": apiKey
    };
    headers.Accept = stream ? "text/event-stream" : "application/json";
    return headers;
  }
}