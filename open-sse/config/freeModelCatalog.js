export { FREE_MODEL_BUDGETS } from "./freeModelCatalog.data";
import { FREE_MODEL_BUDGETS } from "./freeModelCatalog.data";
const RECURRING = new Set(["recurring-daily", "recurring-monthly", "keyless"]);

/**
 * Deposit-unlock boosts: a one-time small top-up that permanently raises a
 * provider's recurring free quota. Kept OUT of the steady headline and surfaced
 * as a separate "unlock more" figure. Keyed by the provider's recurring poolKey.
 */
export const FREE_TIER_BOOSTS = {
  "openrouter-free": {
    provider: "openrouter",
    boostMonthlyTokens: 24_000_000,
    note: "A one-time $10 lifetime top-up raises the free pool from 50 to 1000 requests/day (~24M tokens/month)."
  }
};
function fmt(n) {
  return n >= 1e9 ? (n / 1e9).toFixed(2) + "B" : Math.round(n / 1e6) + "M";
}

// Sum a per-model numeric field, counting each shared pool once (max within the pool);
// poolKey null => the model is independent and counts on its own.
function dedupedSum(models, pick, include) {
  const poolMax = new Map();
  let loose = 0;
  for (const m of models) {
    if (!include(m)) continue;
    const key = m.poolKey;
    if (key) poolMax.set(key, Math.max(poolMax.get(key) ?? 0, pick(m)));else loose += pick(m);
  }
  for (const v of poolMax.values()) loose += v;
  return loose;
}
export function computeFreeModelTotals(opts = {}) {
  const models = FREE_MODEL_BUDGETS.filter(m => !(opts.excludeTosAvoid && m.tos === "avoid"));
  const steadyRecurringTokens = dedupedSum(models, m => m.monthlyTokens, m => RECURRING.has(m.freeType));
  const recurringCredits = dedupedSum(models, m => m.creditTokens, m => m.freeType === "recurring-credit");
  const oneTimeCredits = dedupedSum(models, m => m.creditTokens, m => m.freeType === "one-time-initial");
  const steadyWithRecurringCreditsTokens = steadyRecurringTokens + recurringCredits;
  const firstMonthRealisticTokens = steadyWithRecurringCreditsTokens + oneTimeCredits;
  const poolCount = new Set(models.filter(m => RECURRING.has(m.freeType) && m.poolKey).map(m => m.poolKey)).size;

  // Deposit-unlock boost: sum the FREE_TIER_BOOSTS whose pool still has a live
  // recurring model in the (optionally ToS-filtered) set.
  const livePools = new Set(models.filter(m => RECURRING.has(m.freeType) && m.poolKey).map(m => m.poolKey));
  const boostMonthlyTokens = Object.entries(FREE_TIER_BOOSTS).filter(([pool]) => livePools.has(pool)).reduce((s, [, b]) => s + b.boostMonthlyTokens, 0);

  // Permanently-free-but-uncapped providers (real access, no published cap).
  const uncappedProviders = [...new Set(models.filter(m => m.freeType === "recurring-uncapped").map(m => m.provider))].sort();
  return {
    steadyRecurringTokens,
    steadyWithRecurringCreditsTokens,
    firstMonthRealisticTokens,
    boostMonthlyTokens,
    uncappedProviders,
    modelCount: models.length,
    poolCount,
    perModel: models.slice().sort((a, b) => b.monthlyTokens - a.monthlyTokens),
    headline: `~${fmt(steadyRecurringTokens)} documented free tokens/month (steady), up to ~${fmt(firstMonthRealisticTokens)} in your first month with signup credits`
  };
}