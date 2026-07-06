/**
 * Auto-Combo Engine — The `auto` combo type that self-manages provider selection.
 *
 * Features:
 *   - Scoring-based provider selection from candidate pool
 *   - Bandit exploration (configurable rate, default 5%)
 *   - Budget cap enforcement
 *   - Self-healing integration
 *   - Mode pack support
 */

import { scorePool, validateWeights, DEFAULT_WEIGHTS } from "./scoring";
import { getTaskFitness } from "./taskFitness";
import { getModePack } from "./modePacks";
import { getSelfHealingManager } from "./selfHealing";
import { classifyPromptIntent } from "../intentClassifier";
const TIER_PREFERENCES = {
  smart: {
    top: 0.5,
    mid: 0.3,
    rest: 0.2
  },
  fast: {
    top: 0.3,
    mid: 0.5,
    rest: 0.2
  },
  cheap: {
    top: 0.2,
    mid: 0.3,
    rest: 0.5
  },
  coding: {
    top: 0.6,
    mid: 0.25,
    rest: 0.15
  },
  default: {
    top: 0.45,
    mid: 0.35,
    rest: 0.2
  }
};
function tierPreferencesForName(name) {
  const key = name.toLowerCase();
  if (TIER_PREFERENCES[key]) return TIER_PREFERENCES[key];
  for (const prefix of Object.keys(TIER_PREFERENCES)) {
    if (key.startsWith(`${prefix}-`) || key.includes(prefix)) return TIER_PREFERENCES[prefix];
  }
  return TIER_PREFERENCES.default;
}
const SCORE_EPSILON = 1e-4;
const CLEAR_WINNER_THRESHOLD = 0.1;
class ScoreTierRotator {
  tierCounters = new Map();
  rrCounter = 0;
  constructor(comboName) {
    this.comboName = comboName;
  }
  pick(candidates) {
    if (candidates.length === 0) {
      throw new Error(`ScoreTierRotator: no candidates to pick from for combo=${this.comboName}`);
    }
    if (candidates.length === 1) return candidates[0];
    const tiers = groupIntoTiers(candidates);
    const best = candidates[0].score;
    const worst = candidates[candidates.length - 1].score;
    if (tiers.top.length > 0 && best - worst >= CLEAR_WINNER_THRESHOLD) {
      return this.pickFromPool(tiers.top);
    }
    const prefs = tierPreferencesForName(this.comboName);
    const chosen = chooseTierWeighted(tiers, prefs, pool => this.pickFromPool(pool), () => this.advance(tiers, prefs, candidates));
    return chosen;
  }
  advance(tiers, prefs, candidates) {
    const order = ["top", "mid", "rest"];
    for (const tier of order) {
      if (tiers[tier].length > 0 && prefs[tier] > 0) {
        const idx = this.tierCounters.get(tier) ?? 0;
        const picked = tiers[tier][idx % tiers[tier].length];
        this.tierCounters.set(tier, idx + 1);
        return picked;
      }
    }
    return tiers.top[0] ?? tiers.mid[0] ?? tiers.rest[0] ?? candidates[0];
  }
  pickFromPool(pool) {
    if (pool.length === 0) throw new Error("pickFromPool: empty pool");
    if (pool.length === 1) return pool[0];
    const picked = pool[this.rrCounter % pool.length];
    this.rrCounter = (this.rrCounter + 1) % pool.length;
    return picked;
  }
}
function groupIntoTiers(candidates) {
  if (candidates.length === 0) return {
    top: [],
    mid: [],
    rest: []
  };
  const best = candidates[0].score;
  const worst = candidates[candidates.length - 1].score;
  const range = best - worst;
  const top = [];
  const mid = [];
  const rest = [];
  for (const c of candidates) {
    const delta = best - c.score;
    if (delta <= SCORE_EPSILON) top.push(c);else if (range <= SCORE_EPSILON || delta <= range * 0.3) mid.push(c);else rest.push(c);
  }
  if (mid.length === 0 && rest.length > 0) {
    const half = Math.ceil(rest.length / 2);
    mid.push(...rest.splice(0, half));
  }
  return {
    top,
    mid,
    rest
  };
}
function chooseTierWeighted(tiers, prefs, pickFromPool, fallback) {
  const active = {
    top: tiers.top.length > 0 ? prefs.top : 0,
    mid: tiers.mid.length > 0 ? prefs.mid : 0,
    rest: tiers.rest.length > 0 ? prefs.rest : 0
  };
  const total = active.top + active.mid + active.rest;
  if (total <= 0) return fallback();
  const r = Math.random() * total;
  let acc = 0;
  if (active.top > 0 && (acc += active.top) >= r) return pickFromPool(tiers.top);
  if (active.mid > 0 && (acc += active.mid) >= r) return pickFromPool(tiers.mid);
  if (active.rest > 0) return pickFromPool(tiers.rest);
  return fallback();
}
const comboRotators = new Map();
function getRotator(comboName) {
  let r = comboRotators.get(comboName);
  if (!r) {
    r = new ScoreTierRotator(comboName);
    comboRotators.set(comboName, r);
  }
  return r;
}

/**
 * Select the best provider from an auto-combo pool.
 *
 * @param config - AutoCombo configuration
 * @param candidates - Provider candidates to score
 * @param taskType - Task type hint. When "default" or omitted, the engine will attempt
 *   to infer the intent from `promptMessages` using multilingual classification.
 * @param promptMessages - Optional raw messages for intent classification
 */
export function selectProvider(config, candidates, taskType = "default", promptMessages) {
  const healer = getSelfHealingManager();

  // ── Intent classification (ClawRouter Feature #10/11) ────────────────────
  // When taskType is generic ('default'), attempt to classify the prompt intent
  // using the multilingual intentClassifier for better task fitness scoring.
  let effectiveTaskType = taskType;
  if ((taskType === "default" || taskType === "") && promptMessages?.length) {
    // Extract text from last user message for classification
    const lastUserMsg = [...promptMessages].reverse().find(m => m.role === "user");
    if (lastUserMsg) {
      const text = typeof lastUserMsg.content === "string" ? lastUserMsg.content : Array.isArray(lastUserMsg.content) ? lastUserMsg.content.filter(b => b.type === "text").map(b => b.text || "").join(" ") : "";
      if (text.length > 10) {
        const intent = classifyPromptIntent(text);
        effectiveTaskType = intent; // 'code' | 'reasoning' | 'simple' | 'medium'
      }
    }
  }
  // Resolve weights from mode pack or config
  let weights = config.weights;
  if (config.modePack) {
    const pack = getModePack(config.modePack);
    if (pack) weights = pack;
  }
  if (!validateWeights(weights)) weights = DEFAULT_WEIGHTS;

  // Filter out excluded providers
  const excluded = [];
  const pool = candidates.filter(c => {
    // Pool filter
    if (config.candidatePool.length > 0 && !config.candidatePool.includes(c.provider)) return false;

    // Self-healing exclusion
    const evaluation = healer.evaluate(c.provider, 0.5, c.circuitBreakerState);
    if (evaluation.excluded) {
      excluded.push(c.provider);
      return false;
    }
    return true;
  });
  if (pool.length === 0) {
    // Fallback: allow all candidates regardless of exclusions
    pool.push(...candidates);
    excluded.length = 0;
  }

  // Score all providers (using classified intent if available)
  const scored = scorePool(pool, effectiveTaskType, weights, getTaskFitness);

  // Apply self-healing re-evaluation with actual scores
  const finalCandidates = scored.filter(s => {
    const eval_ = healer.evaluate(s.provider, s.score, "CLOSED");
    if (eval_.excluded) {
      excluded.push(s.provider);
      return false;
    }
    return true;
  });
  const candidates_ = finalCandidates.length > 0 ? finalCandidates : scored;

  // Incident mode check
  const incidentMode = healer.isInIncidentMode();
  const effectiveExplorationRate = incidentMode ? 0 : config.explorationRate;

  // Selection: exploration vs exploitation
  let selected;
  const isExploration = Math.random() < effectiveExplorationRate && candidates_.length > 1;
  if (isExploration) {
    const idx = Math.floor(Math.random() * candidates_.length);
    selected = candidates_[idx];
  } else {
    const rotator = getRotator(config.name);
    selected = rotator.pick(candidates_);
  }

  // Budget cap enforcement
  if (config.budgetCap) {
    const costMap = new Map();
    for (const c of candidates) {
      costMap.set(`${c.provider}\0${c.model}`, c.costPer1MTokens);
    }
    const estimatedCostFor = s => {
      const cost = costMap.get(`${s.provider}\0${s.model}`) ?? 0;
      return cost / 1_000_000 * 1000;
    };
    if (estimatedCostFor(selected) > config.budgetCap) {
      const budgetOk = candidates_.filter(s => estimatedCostFor(s) <= config.budgetCap);
      if (budgetOk.length > 0) {
        const rotator = getRotator(`${config.name}#budget`);
        selected = rotator.pick(budgetOk);
      } else {
        const cheapest = [...candidates_].sort((a, b) => estimatedCostFor(a) - estimatedCostFor(b))[0];
        if (cheapest) selected = cheapest;
      }
    }
  }
  return {
    provider: selected.provider,
    model: selected.model,
    score: selected.score,
    isExploration,
    factors: selected.factors,
    excluded,
    connectionId: selected.connectionId
  };
}

// ============ Auto-Combo Config Schema Reference ============
// Note: AutoCombos are now persisted natively in the SQLite DB via src/lib/db/combos.ts
// using the combo.strategy = "auto" | "lkgp" type, with parameters nested inside combo.config