import { getIdempotencyKey, checkIdempotency } from "../../stubs/lib/idempotencyLayer";
import { calculateCost } from "../../stubs/lib/usage/costCalculator";
import { attachOmniRouteMetaHeaders } from "../../stubs/domain/omnirouteResponseMeta";

/**
 * Resolve the request's idempotency key once and check the idempotency store. Returns the
 * resolved `idempotencyKey` alongside the cache `hit` so the caller can reuse the SAME key
 * for the later save path instead of re-deriving it — eliminating the dual-derivation that
 * the chatCore modularization (#3598) introduced. (#3821-review LEDGER-6)
 */
export async function checkIdempotencyCache({
  clientRawRequest,
  provider,
  model,
  effectiveServiceTier,
  startTime,
  log
}) {
  const idempotencyKey = getIdempotencyKey(clientRawRequest?.headers);
  const cachedIdemp = checkIdempotency(idempotencyKey);
  if (cachedIdemp) {
    log?.debug?.("IDEMPOTENCY", `Hit for key=${idempotencyKey?.slice(0, 12)}...`);
    const idempotentUsage = cachedIdemp.response && typeof cachedIdemp.response === "object" ? cachedIdemp.response.usage : undefined;
    const idempotentCost = idempotentUsage ? await calculateCost(provider, model, idempotentUsage, {
      serviceTier: effectiveServiceTier
    }) : 0;
    const headers = {
      "Content-Type": "application/json",
      "X-OmniRoute-Idempotent": "true"
    };
    attachOmniRouteMetaHeaders(headers, {
      provider,
      model,
      cacheHit: false,
      latencyMs: Date.now() - startTime,
      usage: idempotentUsage,
      costUsd: idempotentCost
    });
    return {
      idempotencyKey,
      hit: {
        success: true,
        response: new Response(JSON.stringify(cachedIdemp.response), {
          status: cachedIdemp.status,
          headers
        })
      }
    };
  }
  return {
    hit: null,
    idempotencyKey
  };
}