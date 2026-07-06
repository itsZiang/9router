import { buildBedrockNativeInferenceProfilesUrl, buildBedrockNativeModelsUrl, normalizeBedrockDiscoveredModels, resolveBedrockRegion } from "../config/bedrock";
export class BedrockNativeApiError extends Error {
  status;
  url;
  body;
  constructor(message, options) {
    super(message);
    this.name = "BedrockNativeApiError";
    this.status = typeof options.status === "number" ? options.status : null;
    this.url = options.url;
    this.body = options.body ?? null;
  }
}
export function isBedrockNativeApiError(error) {
  return error instanceof BedrockNativeApiError;
}
export function isBedrockNativeAuthError(error) {
  return isBedrockNativeApiError(error) && (error.status === 401 || error.status === 403);
}
export function buildBedrockNativeHeaders(apiKey, extraHeaders = {}) {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...(apiKey ? {
      Authorization: "Bearer " + apiKey
    } : {}),
    ...extraHeaders
  };
}
async function readJsonOrText(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
function getErrorMessage(body, fallback) {
  if (body && typeof body === "object") {
    const record = body;
    const message = record.message || record.Message || record.error || record.errorMessage;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  if (typeof body === "string" && body.trim()) return body.trim();
  return fallback;
}
async function fetchBedrockJson(fetcher, url, apiKey, init = {}) {
  const headers = buildBedrockNativeHeaders(apiKey, {
    ...(init.headers || {})
  });
  const response = await fetcher(url, {
    ...init,
    method: init.method || "GET",
    headers
  });
  const body = await readJsonOrText(response);
  if (!response.ok) {
    throw new BedrockNativeApiError(getErrorMessage(body, "Bedrock API request failed with " + response.status), {
      status: response.status,
      url,
      body
    });
  }
  return body;
}
async function fetchInferenceProfiles(fetcher, region, apiKey) {
  const summaries = [];
  let nextToken = null;
  do {
    const data = await fetchBedrockJson(fetcher, buildBedrockNativeInferenceProfilesUrl(region, {
      nextToken
    }), apiKey);
    const record = data && typeof data === "object" ? data : {};
    const pageSummaries = Array.isArray(record.inferenceProfileSummaries) ? record.inferenceProfileSummaries : [];
    summaries.push(...pageSummaries);
    nextToken = typeof record.nextToken === "string" && record.nextToken ? record.nextToken : null;
  } while (nextToken);
  return {
    inferenceProfileSummaries: summaries
  };
}
export async function discoverBedrockNativeModels({
  apiKey,
  providerSpecificData,
  fetcher = fetch
}) {
  const region = resolveBedrockRegion(providerSpecificData);
  const foundationModelsResponse = await fetchBedrockJson(fetcher, buildBedrockNativeModelsUrl(region), apiKey);
  let inferenceProfilesResponse = {
    inferenceProfileSummaries: []
  };
  const warnings = [];
  try {
    inferenceProfilesResponse = await fetchInferenceProfiles(fetcher, region, apiKey);
  } catch (error) {
    if (isBedrockNativeAuthError(error)) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error || "unknown error");
    warnings.push("Bedrock inference profiles unavailable: " + message);
  }
  return {
    region,
    foundationModelsResponse,
    inferenceProfilesResponse,
    models: normalizeBedrockDiscoveredModels(foundationModelsResponse, inferenceProfilesResponse),
    warnings
  };
}