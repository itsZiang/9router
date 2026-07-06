/**
 * chatCore Codex service-tier resolvers (Quality Gate v2 / Fase 9 — chatCore god-file
 * decomposition, #3501).
 *
 * Pure, side-effect-free extraction of the two service-tier resolvers that used to be inline
 * closures at the top of handleChatCore. Both are no-ops for non-Codex providers; for Codex they
 * read the client-supplied `service_tier`, normalize it, and fall back to the per-connection
 * request defaults. Behaviour is byte-identical to the previous inline code — the handler now binds
 * `provider`/`providerSpecificData` once and delegates here.
 */

import { getCodexRequestDefaults, normalizeCodexServiceTier } from "../../stubs/lib/providers/requestDefaults";

/** The effective service tier carried through a request: "standard" or a normalized Codex tier. */

/**
 * Resolve the effective service tier for the *outbound* request. Non-Codex providers are always
 * "standard". For Codex, a valid client `service_tier` wins; otherwise the per-connection request
 * default applies, falling back to "standard".
 */
export function resolveEffectiveServiceTier(provider, providerSpecificData, requestBody) {
  if (provider !== "codex") return "standard";
  const requestRecord = requestBody && typeof requestBody === "object" && !Array.isArray(requestBody) ? requestBody : {};
  const rawServiceTier = requestRecord.service_tier;
  if (typeof rawServiceTier === "string" && rawServiceTier.trim().length > 0) {
    const normalizedServiceTier = normalizeCodexServiceTier(rawServiceTier);
    if (normalizedServiceTier) return normalizedServiceTier;
  }
  return getCodexRequestDefaults(providerSpecificData).serviceTier ?? "standard";
}

/**
 * Resolve the service tier *reported by the upstream* response. Non-Codex providers and missing
 * payloads return null (caller keeps the prior value). For Codex, reads a top-level `service_tier`
 * and otherwise descends through nested `response` envelopes up to `maxDepth` levels.
 */
export function resolveReportedServiceTier(provider, payload, maxDepth = 3) {
  if (maxDepth <= 0 || provider !== "codex" || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload;
  const rawServiceTier = record.service_tier;
  if (typeof rawServiceTier === "string" && rawServiceTier.trim().length > 0) {
    const normalizedServiceTier = normalizeCodexServiceTier(rawServiceTier);
    if (normalizedServiceTier) return normalizedServiceTier;
  }
  return resolveReportedServiceTier(provider, record.response, maxDepth - 1);
}