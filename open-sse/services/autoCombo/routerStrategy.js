/**
 * RouterStrategy — Pluggable Routing Strategy System
 *
 * Inspired by ClawRouter commit 14c83c258 "refactor: extract routing into pluggable RouterStrategy system".
 * Provides a RouterStrategy interface and built-in implementations:
 *   - RulesStrategy (default): wraps the existing 6-factor scoring engine
 *   - CostStrategy: always picks cheapest available model
 *   - LatencyStrategy: prioritizes low p95 latency with reliability weighting
 *   - SLAStrategy: prefers candidates that satisfy latency/error/cost SLOs
 *   - LKGPStrategy: tries last known good provider first
 */

import { scorePool } from "./scoring";
import { getTaskFitness } from "./taskFitness";
import { clamp01 } from "../../utils/number";
// ── RulesStrategy: wraps 6-factor scoring engine ────────────────────────────

class RulesStrategyImpl {
  name = "rules";
  description = "6-factor weighted scoring: quota, health, cost, latency, taskFit, stability";
  select(pool, context) {
    const eligible = pool.filter(c => c.circuitBreakerState !== "OPEN");
    const ranked = scorePool(eligible.length > 0 ? eligible : pool, context.taskType, undefined, getTaskFitness);
    const best = ranked[0];
    if (!best) throw new Error("[RulesStrategy] No candidates to score");
    return {
      provider: best.provider,
      model: best.model,
      strategy: this.name,
      reason: `RulesStrategy: score=${best.score.toFixed(3)} (quota=${best.factors.quota.toFixed(2)}, health=${best.factors.health.toFixed(2)}, cost=${best.factors.costInv.toFixed(2)}, taskFit=${best.factors.taskFit.toFixed(2)})`,
      candidatesConsidered: ranked.length,
      finalScore: best.score
    };
  }
}

// ── CostStrategy: always picks cheapest healthy provider ─────────────────────

class CostStrategyImpl {
  name = "cost";
  description = "Always selects cheapest available provider (by costPer1MTokens)";
  select(pool, context) {
    const healthy = pool.filter(c => c.circuitBreakerState !== "OPEN");
    const candidates = healthy.length > 0 ? healthy : pool;
    const sorted = [...candidates].sort((a, b) => a.costPer1MTokens - b.costPer1MTokens);
    const best = sorted[0];
    if (!best) throw new Error("[CostStrategy] No candidates available");
    return {
      provider: best.provider,
      model: best.model,
      strategy: this.name,
      reason: `CostStrategy: cheapest at $${best.costPer1MTokens.toFixed(3)}/1M tokens`,
      candidatesConsidered: candidates.length,
      finalScore: best.costPer1MTokens === 0 ? 1.0 : 1 / best.costPer1MTokens
    };
  }
}

// ── LatencyStrategy: prioritize low latency + reliability ───────────────────

function positiveMetric(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : null;
}
function boundedRate(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue >= 0 ? Math.min(1, numericValue) : 0;
}
function maxPositiveMetric(candidates, readMetric, fallback = 1) {
  return Math.max(...candidates.map(candidate => positiveMetric(readMetric(candidate)) ?? 0), fallback);
}
function latencyMetricScore(value, maxValue) {
  if (value == null) return 0.5;
  return inverseNormalized(value, maxValue);
}
function throughputMetricScore(value, maxValue) {
  if (value == null) return 0.5;
  return clamp01(value / Math.max(maxValue, 0.000_001));
}
class LatencyStrategyImpl {
  name = "latency";
  description = "Prioritizes the fastest reliable provider-model pair using TTFT, TPS, E2E latency, health, fail rate, and stability";
  select(pool, context) {
    const healthy = pool.filter(c => c.circuitBreakerState !== "OPEN");
    const candidates = healthy.length > 0 ? healthy : pool;
    if (candidates.length === 0) throw new Error("[LatencyStrategy] No candidates available");
    const maxP95 = maxPositiveMetric(candidates, candidate => candidate.p95LatencyMs);
    const maxTtft = maxPositiveMetric(candidates, candidate => candidate.avgTtftMs ?? candidate.p95LatencyMs);
    const maxE2E = maxPositiveMetric(candidates, candidate => candidate.avgE2ELatencyMs ?? candidate.p95LatencyMs);
    const maxTps = maxPositiveMetric(candidates, candidate => candidate.avgTokensPerSecond);
    const maxStdDev = maxPositiveMetric(candidates, candidate => candidate.latencyStdDev, 0.001);
    const scored = candidates.map(candidate => {
      const p95 = positiveMetric(candidate.p95LatencyMs);
      const ttft = positiveMetric(candidate.avgTtftMs) ?? p95;
      const e2e = positiveMetric(candidate.avgE2ELatencyMs) ?? p95;
      const tps = positiveMetric(candidate.avgTokensPerSecond);
      const failureRate = boundedRate(candidate.failureRate ?? candidate.errorRate);
      const healthScore = getHealthScore(candidate);
      const p95Score = latencyMetricScore(p95, maxP95);
      const ttftScore = latencyMetricScore(ttft, maxTtft);
      const e2eScore = latencyMetricScore(e2e, maxE2E);
      const throughputScore = throughputMetricScore(tps, maxTps);
      const reliabilityScore = 1 - failureRate;
      const stabilityScore = latencyMetricScore(positiveMetric(candidate.latencyStdDev), maxStdDev);
      const rawScore = ttftScore * 0.25 + throughputScore * 0.2 + e2eScore * 0.18 + p95Score * 0.12 + reliabilityScore * 0.15 + healthScore * 0.05 + stabilityScore * 0.05;
      const reliabilityMultiplier = Math.max(0.05, reliabilityScore * reliabilityScore);
      const score = rawScore * reliabilityMultiplier * Math.max(0.25, healthScore);
      return {
        candidate,
        score,
        ttft,
        e2e,
        tps,
        failureRate
      };
    }).sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (!best) throw new Error("[LatencyStrategy] No candidates available");
    return {
      provider: best.candidate.provider,
      model: best.candidate.model,
      strategy: this.name,
      reason: `LatencyStrategy: ttft=${best.ttft ?? "n/a"}ms, tps=${best.tps ?? "n/a"}, e2e=${best.e2e ?? "n/a"}ms, p95=${best.candidate.p95LatencyMs}ms, failRate=${(best.failureRate * 100).toFixed(2)}%`,
      candidatesConsidered: candidates.length,
      finalScore: best.score
    };
  }
}

// ── SLAStrategy: favor targets that meet latency/error/cost SLOs ───────────

const DEFAULT_SLA_TARGET_P95_MS = 2_000;
const DEFAULT_SLA_MAX_ERROR_RATE = 0.05;
function toPositiveFinite(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : undefined;
}
function toFiniteRate(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue >= 0 ? Math.min(1, numericValue) : undefined;
}
function inverseNormalized(value, maxValue) {
  if (!Number.isFinite(value) || value < 0) return 0;
  if (!Number.isFinite(maxValue) || maxValue <= 0) return 1;
  return clamp01(1 - value / maxValue);
}
function scoreAtOrBelowThreshold(value, threshold) {
  // A zero threshold is an intentional zero-tolerance policy.
  if (threshold <= 0) return value === 0 ? 1 : 0;
  return clamp01(threshold / Math.max(value, 0.000_001));
}
function getHealthScore(candidate) {
  if (candidate.circuitBreakerState === "CLOSED") return 1;
  if (candidate.circuitBreakerState === "HALF_OPEN") return 0.5;
  return 0;
}
function getSlaViolationScore(candidate, policy) {
  let violation = candidate.circuitBreakerState === "OPEN" ? 1 : 0;
  if (candidate.p95LatencyMs > policy.targetP95Ms) {
    violation += (candidate.p95LatencyMs - policy.targetP95Ms) / policy.targetP95Ms;
  }
  if (candidate.errorRate > policy.maxErrorRate) {
    violation += policy.maxErrorRate > 0 ? (candidate.errorRate - policy.maxErrorRate) / policy.maxErrorRate : candidate.errorRate;
  }
  if (policy.maxCostPer1MTokens > 0 && candidate.costPer1MTokens > policy.maxCostPer1MTokens) {
    violation += (candidate.costPer1MTokens - policy.maxCostPer1MTokens) / policy.maxCostPer1MTokens;
  }
  return violation;
}
class SLAStrategyImpl {
  name = "sla-aware";
  description = "Selects the provider most likely to satisfy latency, error-rate, and cost SLOs";
  select(pool, context) {
    const healthy = pool.filter(c => c.circuitBreakerState !== "OPEN");
    const candidates = healthy.length > 0 ? healthy : pool;
    if (candidates.length === 0) throw new Error("[SLAStrategy] No candidates available");
    const maxCost = Math.max(...candidates.map(c => c.costPer1MTokens), 0.001);
    const maxStdDev = Math.max(...candidates.map(c => c.latencyStdDev), 0.001);
    const policy = {
      targetP95Ms: toPositiveFinite(context.sla?.targetP95Ms) ?? DEFAULT_SLA_TARGET_P95_MS,
      maxErrorRate: toFiniteRate(context.sla?.maxErrorRate) ?? DEFAULT_SLA_MAX_ERROR_RATE,
      maxCostPer1MTokens: toPositiveFinite(context.sla?.maxCostPer1MTokens) ?? 0,
      hardConstraints: context.sla?.hardConstraints === true
    };
    const scored = candidates.map(candidate => {
      const latencyScore = scoreAtOrBelowThreshold(candidate.p95LatencyMs, policy.targetP95Ms);
      const errorScore = scoreAtOrBelowThreshold(candidate.errorRate, policy.maxErrorRate);
      const costScore = policy.maxCostPer1MTokens > 0 ? scoreAtOrBelowThreshold(candidate.costPer1MTokens, policy.maxCostPer1MTokens) : inverseNormalized(candidate.costPer1MTokens, maxCost);
      const stabilityScore = inverseNormalized(candidate.latencyStdDev, maxStdDev);
      const healthScore = getHealthScore(candidate);
      const violationScore = getSlaViolationScore(candidate, policy);
      return {
        candidate,
        violationScore,
        score: latencyScore * 0.35 + errorScore * 0.35 + healthScore * 0.15 + costScore * 0.1 + stabilityScore * 0.05
      };
    }).sort((a, b) => {
      if (policy.hardConstraints) {
        return a.violationScore - b.violationScore || b.score - a.score;
      }
      return b.score - a.score;
    });
    const best = scored[0];
    if (!best) throw new Error("[SLAStrategy] No candidates available after scoring");
    const anyCompliant = scored.some(entry => entry.violationScore === 0);
    const fallbackNote = !anyCompliant ? "; no candidate met all SLA constraints" : "";
    return {
      provider: best.candidate.provider,
      model: best.candidate.model,
      strategy: this.name,
      reason: `SLAStrategy: p95=${best.candidate.p95LatencyMs}ms/${policy.targetP95Ms}ms, errorRate=${(best.candidate.errorRate * 100).toFixed(2)}%/${(policy.maxErrorRate * 100).toFixed(2)}%, cost=$${best.candidate.costPer1MTokens.toFixed(3)}/1M${fallbackNote}`,
      candidatesConsidered: candidates.length,
      finalScore: best.score
    };
  }
}

// ── LKGPStrategy: tries last known good provider first ───────────────────────

class LKGPStrategyImpl {
  name = "lkgp";
  description = "Tries last known good provider first, then falls back to rules";
  select(pool, context) {
    if (context.lkgpEnabled === false) {
      return getStrategy("rules").select(pool, context);
    }
    if (context.lastKnownGoodProvider) {
      const candidates = pool.filter(c => c.provider === context.lastKnownGoodProvider && c.circuitBreakerState !== "OPEN");
      if (candidates.length > 0) {
        const best = candidates[0];
        return {
          provider: best.provider,
          model: best.model,
          strategy: this.name,
          reason: `LKGP: using last known good provider ${best.provider}`,
          candidatesConsidered: 1,
          finalScore: 1.0
        };
      }
    }

    // Fallback to rules strategy
    return getStrategy("rules").select(pool, context);
  }
}

// ── Registry ──────────────────────────────────────────────────────────────────

const strategyRegistry = new Map();
const rulesStrategy = new RulesStrategyImpl();
const costStrategy = new CostStrategyImpl();
const latencyStrategy = new LatencyStrategyImpl();
const slaStrategy = new SLAStrategyImpl();
const lkgpStrategy = new LKGPStrategyImpl();
strategyRegistry.set("rules", rulesStrategy);
strategyRegistry.set("cost", costStrategy);
strategyRegistry.set("eco", costStrategy); // alias
strategyRegistry.set("latency", latencyStrategy);
strategyRegistry.set("fast", latencyStrategy); // alias
strategyRegistry.set("sla-aware", slaStrategy);
strategyRegistry.set("sla", slaStrategy); // alias
strategyRegistry.set("lkgp", lkgpStrategy);
export function getStrategy(name) {
  const strategy = strategyRegistry.get(name);
  if (!strategy) {
    console.warn(`[RouterStrategy] Strategy '${name}' not found, falling back to 'rules'`);
    return rulesStrategy;
  }
  return strategy;
}
export function registerStrategy(name, strategy) {
  if (strategyRegistry.has(name)) {
    console.warn(`[RouterStrategy] Overwriting strategy '${name}'`);
  }
  strategyRegistry.set(name, strategy);
}
export function listStrategies() {
  return [...strategyRegistry.entries()].map(([name, s]) => ({
    name,
    description: s.description
  }));
}
export function selectWithStrategy(pool, context, strategyName = "rules") {
  return getStrategy(strategyName).select(pool, context);
}