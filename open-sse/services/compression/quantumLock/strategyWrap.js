import { detectCachingContext } from "../cachingAware";
import { applyQuantumLock } from "./quantumLockStep";
/** The QuantumLock config to apply, or undefined when absent/disabled. */
export function resolveQuantumLock(options) {
  const ql = options?.config?.quantumLock;
  return ql?.enabled ? ql : undefined;
}

/**
 * Resolve the caching gate. Production passes `options.model` (provider inferred from the
 * model slug) or an explicit `options.cachingContext`; the studio dry-run forces a caching
 * context so the operator can see what WOULD be stabilized.
 */
export function quantumCachingContext(body, options) {
  const ctx = detectCachingContext(body, options?.cachingContext ?? {
    model: options?.model
  });
  return {
    isCachingProvider: ctx.isCachingProvider
  };
}

/** Attach QuantumLock stats to a result, creating a minimal stats carrier when needed. */
function attachQuantumLockStats(result, qlStats) {
  if (result.stats) {
    result.stats.quantumLock = qlStats;
    return result;
  }
  // Downstream compression produced no stats (e.g. message too short to compress).
  // Create a passthrough carrier so the quantumLock field is not lost.
  const carrier = {
    originalTokens: 0,
    compressedTokens: 0,
    savingsPercent: 0,
    techniquesUsed: ["quantum-lock"],
    mode: "off",
    timestamp: Date.now(),
    quantumLock: qlStats
  };
  return {
    ...result,
    stats: carrier
  };
}
export function withQuantumLock(body, ql, ctx, run) {
  if (!ql || !ctx.isCachingProvider) return run(body);
  const {
    body: locked,
    stats
  } = applyQuantumLock(body, ql, ctx);
  const result = run(locked);
  if (stats.fragments > 0) return attachQuantumLockStats(result, stats);
  return result;
}
export async function withQuantumLockAsync(body, ql, ctx, run) {
  if (!ql || !ctx.isCachingProvider) return run(body);
  const {
    body: locked,
    stats
  } = applyQuantumLock(body, ql, ctx);
  const result = await run(locked);
  if (stats.fragments > 0) return attachQuantumLockStats(result, stats);
  return result;
}