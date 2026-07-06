import { estimateCompressionTokens } from "../stats";
/**
 * Mechanical savings for a full-vs-compressed body pair. Reuses the production
 * token estimator so the eval reports the same numbers the pipeline reports.
 * `costPerKTokenIn` (USD per 1000 input tokens) is optional — when supplied, the
 * positive cost saved on the input side is reported (the eval does not model output cost).
 */
export function computeSavings(fullBody, compressedBody, costPerKTokenIn) {
  const tokensBefore = estimateCompressionTokens(fullBody);
  const tokensAfter = estimateCompressionTokens(compressedBody);
  const ratio = tokensBefore > 0 ? Math.round(tokensAfter / tokensBefore * 10000) / 10000 : 1;
  const result = {
    tokensBefore,
    tokensAfter,
    ratio
  };
  if (typeof costPerKTokenIn === "number" && costPerKTokenIn > 0) {
    const saved = (tokensBefore - tokensAfter) / 1000 * costPerKTokenIn;
    result.costDelta = Math.round(saved * 1e6) / 1e6;
  }
  return result;
}