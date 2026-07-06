/**
 * Context-budget adaptive compression — shared types.
 *
 * Naming note: "adaptiveCompression"/"contextBudget" — NOT "headroom" (which is an
 * unrelated existing engine). "headroom" here = the budget signal (target − prompt tokens).
 */

/** Target-derivation policy (design D-C1). */

/**
 * Adaptive mode (design D-C3/C4):
 *  - "floor"               : guarantee fit; escalate BEYOND any base plan.
 *  - "replace-autotrigger" : only acts when the base plan is bare Default/off (an explicit
 *                            operator/client choice always wins, even if it overflows).
 *  - "off"                 : legacy binary auto-trigger (full backward-compat).
 */

/** One escalation stage = an engine id applied at an optional intensity. */

/** Persisted adaptive settings (design §4.4). All optional with safe defaults in computeTarget. */

/** The `adaptive` block of the shared CompressionRunTelemetry contract (roadmap overview). */

/** Safe defaults applied when a field is absent (design §4.4 / §6). */
export const DEFAULT_CONTEXT_BUDGET = {
  mode: "off",
  policy: "reserve-output",
  outputReserve: 4096,
  safetyMargin: 1024,
  pct: 0.85,
  absoluteBudget: 0
};