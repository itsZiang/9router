/**
 * Web-Session Pool Health — Aggregation Service (PR4 of issue #3368)
 *
 * Combines PoolRegistry stats with accountFallback breaker state
 * into a unified health report for web-session pools.
 *
 * Health classification:
 *   - "down"     → breaker OPEN or all sessions dead
 *   - "degraded" → success rate < 80% or >50% sessions in cooldown/dead
 *   - "healthy"  → all metrics nominal
 */

import { PoolRegistry } from "./sessionPool/poolRegistry";
import { isProviderInCooldown, getProviderCooldownRemainingMs } from "./accountFallback";
import { getAllCircuitBreakerStatuses } from "../stubs/shared/utils/circuitBreaker";

// ─── Dependency Injection (for testability) ─────────────────────────────────

const defaultDeps = {
  listProviders: () => PoolRegistry.listProviders(),
  getStats: p => PoolRegistry.getStats(p),
  getSessionDetails: p => PoolRegistry.getSessionDetails(p),
  isProviderInCooldown: p => isProviderInCooldown(p),
  getProviderCooldownRemainingMs: p => getProviderCooldownRemainingMs(p),
  getProviderBreakerState: p => {
    const statuses = getAllCircuitBreakerStatuses();
    const match = statuses.find(s => s.name === p);
    if (!match) return null;
    return {
      state: match.state,
      failureCount: match.failureCount,
      lastFailureTime: match.lastFailureTime,
      retryAfterMs: match.retryAfterMs
    };
  }
};

// ─── Types ──────────────────────────────────────────────────────────────────

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Parse a numeric value from a percentage string like "95.0%".
 * Returns NaN if parsing fails.
 */
function parsePercentString(value) {
  if (!value) return NaN;
  const num = parseFloat(value.replace("%", ""));
  return Number.isFinite(num) ? num : NaN;
}

/**
 * Compute health status from pool stats and breaker state.
 */
function computeHealth(pool, breaker) {
  const issues = [];

  // Check breaker state first — most critical
  if (breaker?.inCooldown) {
    issues.push(`breaker OPEN (cooldown ${breaker.cooldownRemainingMs ?? 0}ms remaining)`);
    return {
      health: "down",
      issues
    };
  }

  // Check pool state
  if (pool) {
    // All sessions dead → down
    if (pool.totalSessions > 0 && pool.activeSessions === 0 && pool.cooldownSessions === 0) {
      issues.push(`all ${pool.deadSessions} sessions dead`);
      return {
        health: "down",
        issues
      };
    }

    // Success rate < 80% → degraded (only when pool has handled requests)
    if (pool.totalRequests > 0) {
      const successRate = parsePercentString(pool.successRate);
      if (Number.isFinite(successRate) && successRate < 80) {
        issues.push(`success rate ${pool.successRate} below 80% threshold`);
      }
    }

    // >50% sessions in cooldown/dead → degraded
    if (pool.totalSessions > 0) {
      const unhealthyRatio = (pool.cooldownSessions + pool.deadSessions) / pool.totalSessions;
      if (unhealthyRatio > 0.5) {
        issues.push(`${pool.cooldownSessions + pool.deadSessions}/${pool.totalSessions} sessions in cooldown/dead`);
      }
    }
    if (issues.length > 0) {
      return {
        health: "degraded",
        issues
      };
    }
  }
  return {
    health: "healthy",
    issues
  };
}

/**
 * Build pool info from PoolRegistry stats.
 */
function buildPoolInfo(stats) {
  if (!stats) return null;
  const elapsedMs = Date.now() - stats.createdAt;
  return {
    totalSessions: stats.sessions.total,
    activeSessions: stats.sessions.active,
    cooldownSessions: stats.sessions.cooldown,
    deadSessions: stats.sessions.dead,
    totalRequests: stats.requests.total,
    successfulRequests: stats.requests.success,
    successRate: stats.successRate,
    throughput: stats.throughput,
    uptime: formatDuration(elapsedMs)
  };
}

/**
 * Build breaker info from accountFallback functions.
 */
function buildBreakerInfo(provider, deps) {
  const breakerState = deps.getProviderBreakerState(provider);
  if (!breakerState) return null;
  const inCooldown = deps.isProviderInCooldown(provider);
  const cooldownRemainingMs = deps.getProviderCooldownRemainingMs(provider);
  return {
    state: breakerState.state ?? "UNKNOWN",
    inCooldown,
    cooldownRemainingMs,
    failureCount: breakerState.failureCount ?? 0,
    lastFailureAt: breakerState.lastFailureTime ?? null
  };
}

/**
 * Map PoolSessionDetail[] to our output format.
 */
function mapSessionDetails(details) {
  if (!details) return [];
  return details.map(d => ({
    id: d.id,
    fingerprint: d.fingerprint,
    status: d.status,
    totalRequests: d.totalRequests,
    successfulRequests: d.successfulRequests,
    successRate: d.successRate,
    inflight: d.inflight,
    cooldownRemaining: d.cooldownRemaining,
    age: d.age
  }));
}

/**
 * Format a duration in ms to a human-readable string.
 * Examples: "2h 15m", "5s", "30m", "none"
 */
function formatDuration(ms) {
  if (ms <= 0) return "none";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMins = minutes % 60;
  if (remainMins === 0) return `${hours}h`;
  return `${hours}h ${remainMins}m`;
}

// ─── Main Export ────────────────────────────────────────────────────────────

/**
 * Get aggregated web-session pool health for one or all providers.
 *
 * @param provider - Optional provider name. If omitted, returns all registered pools.
 * @returns Health report with per-provider pool stats, breaker state, and health classification.
 */
export function getWebSessionPoolHealth(provider, deps = defaultDeps) {
  const checkedAt = new Date().toISOString();
  const providers = provider ? [provider] : deps.listProviders();
  const results = providers.map(p => {
    const stats = deps.getStats(p);
    const sessionDetails = deps.getSessionDetails(p);
    const poolInfo = buildPoolInfo(stats);
    const breakerInfo = buildBreakerInfo(p, deps);
    const sessions = mapSessionDetails(sessionDetails);
    const {
      health,
      issues
    } = computeHealth(poolInfo, breakerInfo);
    return {
      provider: p,
      pool: poolInfo,
      breaker: breakerInfo,
      sessions,
      health,
      issues
    };
  });
  return {
    checkedAt,
    providers: results
  };
}