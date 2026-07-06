import { getResolvedModelCapabilities } from "../stubs/lib/modelCapabilities";
export function toPositiveInteger(value) {
  const numericValue = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : null;
  if (numericValue === null || !Number.isFinite(numericValue)) return null;
  const normalized = Math.floor(numericValue);
  return normalized > 0 ? normalized : null;
}
export function resolveReasoningBufferedMaxTokens(modelStr, currentMaxTokens, options = {}) {
  if (options.enabled === false) return null;
  const current = toPositiveInteger(currentMaxTokens);
  if (current === null) return null;
  const capabilities = getResolvedModelCapabilities(modelStr);
  if (capabilities.supportsThinking !== true) return null;
  const maxOutputTokens = toPositiveInteger(capabilities.maxOutputTokens);
  if (maxOutputTokens === null) return null;
  if (current > maxOutputTokens) return maxOutputTokens;
  if (current === maxOutputTokens) return current;
  const buffered = Math.max(current + 1000, Math.ceil(current * 1.5));
  if (buffered > maxOutputTokens) return current;
  return buffered;
}