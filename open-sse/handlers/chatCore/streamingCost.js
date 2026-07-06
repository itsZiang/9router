/**
 * chatCore streaming per-request cost recording (Quality Gate v2 / Fase 9 — chatCore god-file
 * decomposition, #3501).
 *
 * Extracted from handleChatCore's onStreamComplete: resolves the real per-request cost for a
 * completed streaming response and records it against the api key. onStreamComplete is synchronous,
 * so this is a sync fire-and-forget driven through calculateCost().then().catch() that never throws
 * to the caller. calculateCost and recordCost are injected so the hook stays decoupled. Behaviour
 * is byte-identical to the previous inline block.
 */

export function recordStreamingCost(args) {
  if (!args.apiKeyId || !args.streamUsage) return;
  const apiKeyId = args.apiKeyId;
  args.calculateCost(args.provider, args.model, args.streamUsage, {
    serviceTier: args.serviceTier
  }).then(estimatedCost => {
    if (estimatedCost > 0) args.recordCost(apiKeyId, estimatedCost);
  }).catch(() => {});
}