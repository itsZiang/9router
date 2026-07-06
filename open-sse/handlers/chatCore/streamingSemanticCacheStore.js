/**
 * chatCore streaming semantic-cache store (Quality Gate v2 / Fase 9 — chatCore god-file
 * decomposition, #3501).
 *
 * Extracted from handleChatCore's onStreamComplete callback: after a 200 streaming response is
 * assembled, store it under its signature so a future temp=0 request can be served from cache.
 * Side-effect only (cache write + debug log), wrapped in fail-open try/catch. Behaviour is
 * byte-identical to the previous inline block — including the `_streamed` strip, the early
 * skip-on-too-large, and the `Number(...) || 0` token accounting. The early return was the last
 * statement of the callback, so returning from this helper is equivalent.
 */
import { generateSignature as defaultGenerateSignature, setCachedResponse as defaultSetCachedResponse, isCacheableForWrite as defaultIsCacheableForWrite } from "../../stubs/lib/semanticCache";
import { isSmallEnoughForSemanticCache as defaultIsSmallEnough } from "../../utils/estimateSize";
const DEFAULT_DEPS = {
  isCacheableForWrite: defaultIsCacheableForWrite,
  isSmallEnoughForSemanticCache: defaultIsSmallEnough,
  generateSignature: defaultGenerateSignature,
  setCachedResponse: defaultSetCachedResponse
};
function streamTokensSaved(streamUsage) {
  const u = streamUsage;
  return (Number(u?.prompt_tokens ?? 0) || 0) + (Number(u?.completion_tokens ?? 0) || 0);
}
function writeStreamingCacheEntry(args, deps) {
  try {
    const cleanBody = {
      ...args.streamResponseBody
    };
    delete cleanBody._streamed;
    if (!deps.isSmallEnoughForSemanticCache(cleanBody)) return;
    const sig = deps.generateSignature(args.model, args.body.messages ?? args.body.input, args.body.temperature, args.body.top_p, args.apiKeyId ?? undefined);
    const tokensSaved = streamTokensSaved(args.streamUsage);
    deps.setCachedResponse(sig, args.model, cleanBody, tokensSaved);
    args.log?.debug?.("CACHE", `Stored streaming response for ${args.model} (${tokensSaved} tokens)`);
  } catch {
    // Cache write failed — non-critical
  }
}
export function storeStreamingSemanticCacheResponse(args, deps = DEFAULT_DEPS) {
  if (!args.enabled || args.streamStatus !== 200 || !args.streamResponseBody || !deps.isCacheableForWrite(args.body, args.headers)) {
    return;
  }
  writeStreamingCacheEntry(args, deps);
}