/**
 * chatCore non-streaming usage-stats persistence (Quality Gate v2 / Fase 9 — chatCore god-file
 * decomposition, #3501 — response-handling slice of executeProviderRequest).
 *
 * Extracted from handleChatCore's non-streaming success path: records per-request usage analytics
 * for a successful non-streaming response — an optional trace console line, the fire-and-forget
 * `saveRequestUsage` row, and the per-api-key billable-token counter. Side-effect only (no handler
 * state is mutated, nothing is returned); best-effort, every write swallows its own errors. The
 * per-request context is threaded via `ctx` so the call site stays byte-identical; behaviour is
 * unchanged.
 */

import { saveRequestUsage } from "@/lib/usageDb";
import { formatUsageLog } from "../../stubs/lib/usage/tokenAccounting";
import { COLORS } from "../../utils/stream";
import { recordTokenUsage } from "../../services/tokenLimitCounter";
import { computeBillableTokens } from "./upstreamTimeouts";
import { logUsage } from "../../utils/usageTracking";

function logUsageTrace(usage, provider, connectionId, model, latencyMs) {
  // Use the unified logUsage helper for non-streaming requests too.
  // Passing isStream=false to indicate a sync request.
  logUsage(provider, usage, model, connectionId, null, latencyMs, "ok", false);
}
function persistUsageRow(usage, ctx) {
  const {
    provider,
    connectionId,
    model,
    startTime,
    apiKeyInfo,
    effectiveServiceTier
  } = ctx;
  saveRequestUsage({
    provider: provider || "unknown",
    model: model || "unknown",
    tokens: usage,
    status: "200",
    success: true,
    latencyMs: Date.now() - startTime,
    timeToFirstTokenMs: Date.now() - startTime,
    errorCode: null,
    timestamp: new Date().toISOString(),
    connectionId: connectionId || undefined,
    apiKeyId: apiKeyInfo?.id || undefined,
    apiKeyName: apiKeyInfo?.name || undefined,
    serviceTier: effectiveServiceTier,
    comboStrategy: ctx.isCombo ? ctx.comboStrategy || undefined : undefined,
    endpoint: ctx.endpoint || undefined
  }).catch(err => {
    console.error("Failed to save usage stats:", err.message);
  });
}
function recordBillableTokens(usage, apiKeyInfo, provider, model) {
  if (!apiKeyInfo?.id) return;
  try {
    const billable = computeBillableTokens(usage);
    if (billable > 0) recordTokenUsage(apiKeyInfo.id, provider || "unknown", model || "unknown", billable);
  } catch {
    // never block the response on counter recording
  }
}
export function recordNonStreamingUsageStats(usage, ctx) {
  if (!usage || typeof usage !== "object") {
    return;
  }
  const latencyMs = Date.now() - ctx.startTime;
  logUsageTrace(usage, ctx.provider, ctx.connectionId, ctx.model, latencyMs);
  persistUsageRow(usage, ctx);
  recordBillableTokens(usage, ctx.apiKeyInfo, ctx.provider, ctx.model);
}