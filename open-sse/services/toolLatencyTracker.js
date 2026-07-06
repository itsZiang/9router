/**
 * Tracks per-provider tool call latency metrics.
 * Resets on server restart.
 */

const metrics = new Map();
export function recordToolLatency(provider, ttftAfterToolMs, gapAfterToolMs) {
  if (!provider) return;
  if (!metrics.has(provider)) {
    metrics.set(provider, {
      totalRequests: 0,
      ttftAfterToolSum: 0,
      gapAfterToolSum: 0,
      ttftCount: 0,
      gapCount: 0
    });
  }
  const entry = metrics.get(provider);
  entry.totalRequests++;
  if (ttftAfterToolMs != null && ttftAfterToolMs >= 0) {
    entry.ttftAfterToolSum += ttftAfterToolMs;
    entry.ttftCount++;
  }
  if (gapAfterToolMs != null && gapAfterToolMs >= 0) {
    entry.gapAfterToolSum += gapAfterToolMs;
    entry.gapCount++;
  }
}
export function getToolLatencyByProvider() {
  const result = {};
  for (const [provider, entry] of metrics) {
    result[provider] = {
      avgTtftAfterToolMs: entry.ttftCount > 0 ? Math.round(entry.ttftAfterToolSum / entry.ttftCount) : 0,
      avgGapAfterToolMs: entry.gapCount > 0 ? Math.round(entry.gapAfterToolSum / entry.gapCount) : 0,
      measurementCount: entry.totalRequests
    };
  }
  return result;
}
export function recordToolTtft(provider, ttftMs) {
  if (!provider || ttftMs < 0) return;
  if (!metrics.has(provider)) {
    metrics.set(provider, {
      totalRequests: 0,
      ttftAfterToolSum: 0,
      gapAfterToolSum: 0,
      ttftCount: 0,
      gapCount: 0
    });
  }
  const entry = metrics.get(provider);
  entry.totalRequests++;
  entry.ttftAfterToolSum += ttftMs;
  entry.ttftCount++;
}
export function resetToolLatency() {
  metrics.clear();
}