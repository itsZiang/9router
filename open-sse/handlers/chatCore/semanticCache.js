import { generateSignature, getCachedResponse, isCacheableForRead } from "../../stubs/lib/semanticCache";
import { calculateCost } from "../../stubs/lib/usage/costCalculator";
import { trackPendingRequest } from "@/lib/usageDb";
import { synthesizeOpenAiSseFromJson } from "../../utils/jsonToSse";
import { attachOmniRouteMetaHeaders } from "../../stubs/domain/omnirouteResponseMeta";
import { extractUsageFromResponse } from "../usageExtractor";
import { OMNIROUTE_RESPONSE_HEADERS } from "../../stubs/shared/constants/headers";
export async function checkSemanticCache({
  semanticCacheEnabled,
  body,
  clientRawRequest,
  model,
  provider,
  stream,
  reqLogger,
  effectiveServiceTier,
  connectionId,
  startTime,
  log,
  persistAttemptLogs,
  apiKeyId
}) {
  if (semanticCacheEnabled && isCacheableForRead(body, clientRawRequest?.headers)) {
    const signature = generateSignature(model, body.messages ?? body.input, body.temperature, body.top_p, apiKeyId ?? undefined);
    const cached = getCachedResponse(signature);
    if (cached) {
      log?.debug?.("CACHE", `Semantic cache HIT for ${model} (stream=${stream})`);
      reqLogger.logConvertedResponse(cached);
      const cachedUsage = extractUsageFromResponse(cached, provider) || cached?.usage;
      const cachedCost = cachedUsage ? await calculateCost(provider, model, cachedUsage, {
        serviceTier: effectiveServiceTier
      }) : 0;
      persistAttemptLogs({
        status: 200,
        tokens: cached?.usage,
        responseBody: cached,
        providerRequest: null,
        providerResponse: null,
        clientResponse: cached,
        cacheSource: "semantic"
      });
      trackPendingRequest(model, provider, connectionId, false);
      const cachedSse = stream ? synthesizeOpenAiSseFromJson(JSON.stringify(cached)) : "";
      const headers = {
        "Content-Type": cachedSse ? "text/event-stream" : "application/json",
        [OMNIROUTE_RESPONSE_HEADERS.cache]: "HIT"
      };
      // A cache HIT serves WITHOUT an upstream call, so the incremental cost billed to
      // the client is 0 (consumers that sum X-OmniRoute-Response-Cost must not charge for
      // hits). The original/would-have-been cost is surfaced via X-OmniRoute-Cost-Saved.
      attachOmniRouteMetaHeaders(headers, {
        provider,
        model,
        cacheHit: true,
        latencyMs: Date.now() - startTime,
        usage: cachedUsage,
        costUsd: 0,
        costSavedUsd: cachedCost
      });
      return {
        success: true,
        response: new Response(cachedSse || JSON.stringify(cached), {
          headers
        })
      };
    }
  }
  return null;
}