/**
 * chatCore streaming usage-stats persistence (Quality Gate v2 / Fase 9 — chatCore god-file
 * decomposition, #3501).
 *
 * Extracted from handleChatCore's onStreamComplete: records per-request usage analytics for a
 * completed streaming response — the fire-and-forget `saveRequestUsage` row and the per-api-key
 * billable-token counter (only on a 200 stream). Side-effect only (no handler state is mutated,
 * nothing is returned); best-effort, every write swallows its own errors. The per-request context
 * is threaded via `ctx` so the call site stays byte-identical; behaviour is unchanged. The
 * compression usage-receipt attach stays in the handler (it is a handler-bound closure).
 */

import { saveRequestUsage } from "@/lib/usageDb";
import { recordTokenUsage } from "../../services/tokenLimitCounter";
import { computeBillableTokens } from "./upstreamTimeouts";
function persistStreamingUsageRow(usage, ctx) {
  const {
    provider,
    model,
    streamStatus,
    startTime,
    ttft,
    streamErrorCode
  } = ctx;
  saveRequestUsage({
    provider: provider || "unknown",
    model: model || "unknown",
    tokens: usage,
    status: String(streamStatus),
    success: streamStatus === 200,
    latencyMs: Date.now() - startTime,
    timeToFirstTokenMs: ttft,
    errorCode: streamStatus === 200 ? null : streamErrorCode || String(streamStatus),
    timestamp: new Date().toISOString(),
    connectionId: ctx.connectionId || undefined,
    apiKeyId: ctx.apiKeyInfo?.id || undefined,
    apiKeyName: ctx.apiKeyInfo?.name || undefined,
    serviceTier: ctx.effectiveServiceTier,
    comboStrategy: ctx.isCombo ? ctx.comboStrategy || undefined : undefined,
    endpoint: ctx.endpoint || undefined
  }).catch(err => {
    console.error("Failed to save usage stats:", err.message);
  });
}
function recordStreamingBillableTokens(usage, ctx) {
  if (!ctx.apiKeyInfo?.id || ctx.streamStatus !== 200) return;
  try {
    const billable = computeBillableTokens(usage);
    if (billable > 0) recordTokenUsage(ctx.apiKeyInfo.id, ctx.provider || "unknown", ctx.model || "unknown", billable);
  } catch {
    // never block the stream on counter recording
  }
}
export function recordStreamingUsageStats(usage, ctx) {
  if (!usage || typeof usage !== "object") return;
  persistStreamingUsageRow(usage, ctx);
  recordStreamingBillableTokens(usage, ctx);
}