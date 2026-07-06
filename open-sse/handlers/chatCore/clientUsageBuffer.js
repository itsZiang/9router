/**
 * chatCore client usage buffer/estimate (Quality Gate v2 / Fase 9 — chatCore god-file
 * decomposition, #3501).
 *
 * Extracted from handleChatCore's non-streaming success path: add a buffer to the response usage
 * and filter it for the client format (to prevent CLI context errors); if the provider returned no
 * usage block, fall back to estimating from the serialized content length. Mutates
 * `translatedResponse.usage` in place — byte-identical to the previous inline block, including the
 * `?.usage` guard, the `JSON.stringify(... || "")` content-length, and the `> 0` estimate gate.
 */
import { addBufferToUsage as defaultAddBuffer, filterUsageForFormat as defaultFilterUsage, estimateUsage as defaultEstimateUsage } from "../../utils/usageTracking";
const DEFAULT_DEPS = {
  addBufferToUsage: defaultAddBuffer,
  filterUsageForFormat: defaultFilterUsage,
  estimateUsage: defaultEstimateUsage
};
export function applyClientUsageBuffer(translatedResponse, body, clientResponseFormat, deps = DEFAULT_DEPS) {
  // Add buffer and filter usage for client (to prevent CLI context errors)
  if (translatedResponse?.usage) {
    const buffered = deps.addBufferToUsage(translatedResponse.usage);
    translatedResponse.usage = deps.filterUsageForFormat(buffered, clientResponseFormat);
  } else {
    // Fallback: estimate usage when provider returned no usage block
    const contentLength = JSON.stringify(translatedResponse?.choices?.[0]?.message?.content || "").length;
    if (contentLength > 0) {
      const estimated = deps.estimateUsage(body, contentLength, clientResponseFormat);
      translatedResponse.usage = deps.filterUsageForFormat(estimated, clientResponseFormat);
    }
  }
}