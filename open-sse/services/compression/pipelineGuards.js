/**
 * Aggregate guards for the stacked compression pipeline (T02 / Headroom H1).
 *
 * These operate on the WHOLE pipeline result, distinct from the opt-in per-step TV1 bail-out
 * (`decideStep` in `strategySelector.ts`): TV1 governs whether to ADVANCE between steps and is
 * default-off; the inflation guard here is an honest DEFAULT-ON check on the FINAL output.
 */

/**
 * Honest aggregate inflation guard. If the fully-stacked body did not actually shrink — its token
 * count is `>=` the original — the compressed body is discarded and the verbatim original is
 * returned.
 *
 * Safe by construction: the only alternative it ever returns is `originalBody`, the unmodified
 * request, which is always a valid payload. A (rare) false trigger therefore can never corrupt a
 * payload — it only forgoes a compression that saved nothing.
 *
 * `originalTokens === 0` (empty/degenerate input) is treated as "not inflated" so an empty body is
 * never spuriously flagged.
 */
export function guardPipelineInflation(input) {
  const {
    originalTokens,
    compressedTokens
  } = input;
  if (originalTokens > 0 && compressedTokens >= originalTokens) {
    return {
      body: input.originalBody,
      inflated: true
    };
  }
  return {
    body: input.compressedBody,
    inflated: false
  };
}