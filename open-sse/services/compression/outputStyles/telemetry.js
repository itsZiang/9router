/** The CompressionRunTelemetry fields this sub-project (A) fills. Clock-free / pure. */

// Benign (non-content-bypass) skips that must NOT be recorded as a bypass reason.
const BENIGN_SKIPS = new Set(["disabled", "no_styles", "no_messages", "already_applied"]);
export function buildOutputStyleTelemetry(input) {
  const ratio = input.tokensBefore > 0 ? input.tokensAfter / input.tokensBefore : 0;
  const record = {
    requestId: input.requestId,
    model: input.model,
    provider: input.provider,
    source: input.source,
    tokensBefore: input.tokensBefore,
    tokensAfter: input.tokensAfter,
    ratio
  };
  if (input.applied && input.appliedStyles && input.appliedStyles.length > 0) {
    record.outputStyles = input.appliedStyles;
  }
  if (!input.applied && input.skippedReason && !BENIGN_SKIPS.has(input.skippedReason)) {
    record.outputStyleBypass = input.skippedReason;
  }
  if (typeof input.outputTokens === "number") record.outputTokens = input.outputTokens;
  return record;
}