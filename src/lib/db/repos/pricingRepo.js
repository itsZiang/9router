import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { makeKv } from "../helpers/kvStore.js";

const pricingKv = makeKv("pricing");
const CACHE_TTL_MS = 5000;

let cache = { value: null, expiresAt: 0 };

function invalidate() {
  cache = { value: null, expiresAt: 0 };
}

async function getUserPricing() {
  return await pricingKv.getAll();
}

/**
 * Collect which providers have active connections and which model IDs they expose.
 *
 * Two sources of model IDs:
 *   1. Known providers (in PROVIDER_MODELS) → fixed model list
 *   2. Custom openai/anthropic-compatible providers (passthrough) → usage history
 *
 * Fallback:
 *   modelIds = null  → show ALL models (no connections at all, or only truly
 *                      unknown providers → can't determine what to filter)
 *   modelIds = Set   → only show models derived from the two sources above
 */
async function getEnabledProviderInfo() {
  try {
    const { getProviderConnections } = await import("./connectionsRepo.js");
    const conns = await getProviderConnections({ isActive: true });
    if (!conns.length) return { modelIds: null, providerIds: new Set() };

    const { PROVIDER_MODELS } = await import("@/open-sse/config/providerModels.js");
    const { isOpenAICompatibleProvider, isAnthropicCompatibleProvider } =
      await import("@/shared/constants/providers.js");

    const providerIds = new Set();
    const modelIds = new Set();
    const providerModelsMap = {};
    const passthroughIds = [];

    for (const c of conns) {
      providerIds.add(c.provider);
      const models = PROVIDER_MODELS[c.provider];
      if (models) {
        // Known provider → fixed model list from PROVIDER_MODELS
        for (const m of models) modelIds.add(m.id);
        providerModelsMap[c.provider] = models.map(m => m.id);
      } else if (isOpenAICompatibleProvider(c.provider) || isAnthropicCompatibleProvider(c.provider)) {
        // Custom openai/anthropic-compatible → passthrough, find models from usage
        passthroughIds.push(c.provider);
      }
      // Truly unknown providers → silently ignored
    }

    // For custom passthrough providers, pull actually-used models from usage history.
    // Only count successful requests (status='ok') — failed/garbage model names
    // that never completed a request should not appear in pricing.
    if (passthroughIds.length) {
      try {
        const db = await getAdapter();
        const placeholders = passthroughIds.map(() => "?").join(",");
        const rows = db.all(
          `SELECT DISTINCT model, provider FROM usageHistory
           WHERE provider IN (${placeholders}) AND status = 'ok'
           ORDER BY timestamp DESC LIMIT 200`,
          passthroughIds
        );
        for (const r of rows) {
          modelIds.add(r.model);
          if (!providerModelsMap[r.provider]) providerModelsMap[r.provider] = [];
          if (!providerModelsMap[r.provider].includes(r.model)) {
            providerModelsMap[r.provider].push(r.model);
          }
        }
      } catch {
        // usageHistory table may not exist yet (first boot) — ignore
      }
    }

    return {
      modelIds: modelIds.size ? modelIds : null,
      providerIds,
      providerModelsMap,
    };
  } catch {
    return { modelIds: null, providerIds: new Set(), providerModelsMap: {} };
  }
}

export async function getPricing() {
  const now = Date.now();
  if (cache.value && cache.expiresAt > now) return cache.value;

  const userPricing = await getUserPricing();
  const { PROVIDER_PRICING, MODEL_PRICING } = await import("@/shared/constants/pricing.js");
  const { modelIds, providerIds, providerModelsMap } = await getEnabledProviderInfo();
  const merged = {};

  // Seed model defaults under "*" — filtered to models from enabled providers
  merged["*"] = {};
  for (const [model, pricing] of Object.entries(MODEL_PRICING)) {
    if (!modelIds || modelIds.has(model)) {
      merged["*"][model] = pricing;
    }
  }

  // Provider-specific overrides — only for enabled providers
  for (const [provider, models] of Object.entries(PROVIDER_PRICING)) {
    if (providerIds.has(provider)) {
      merged[provider] = { ...models };
    }
  }

  // Apply user overrides on top
  for (const [provider, models] of Object.entries(userPricing)) {
    if (!merged[provider]) {
      merged[provider] = { ...models };
    } else {
      for (const [model, pricing] of Object.entries(models)) {
        merged[provider][model] = merged[provider][model]
          ? { ...merged[provider][model], ...pricing }
          : pricing;
      }
    }
  }

  // Attach provider→model mapping for UI filtering
  merged._providerModels = providerModelsMap;

  cache = { value: merged, expiresAt: now + CACHE_TTL_MS };
  return merged;
}

export async function getPricingForModel(provider, model) {
  if (!model) return null;
  const userPricing = await getUserPricing();
  // 1. Provider-specific user override (e.g. openai/gpt-4o)
  if (provider && userPricing[provider]?.[model]) return userPricing[provider][model];
  // 2. Generic model override from "*" provider (applies to all providers)
  if (userPricing["*"]?.[model]) return userPricing["*"][model];
  // 3. Built-in constants chain: PROVIDER_PRICING → MODEL_PRICING → PATTERN_PRICING
  const { getPricingForModel: resolveConst } = await import("@/shared/constants/pricing.js");
  return resolveConst(provider, model);
}

// Atomic merge inside transaction (per-provider read-modify-write)
export async function updatePricing(pricingData) {
  const db = await getAdapter();
  db.transaction(() => {
    for (const [provider, models] of Object.entries(pricingData)) {
      const row = db.get(`SELECT value FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
      const current = row ? (parseJson(row.value, {}) || {}) : {};
      const merged = { ...current };
      for (const [model, pricing] of Object.entries(models)) {
        merged[model] = pricing;
      }
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES('pricing', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [provider, stringifyJson(merged)]
      );
    }
  });
  invalidate();
  return await getUserPricing();
}

export async function resetPricing(provider, model) {
  if (!provider) return await getUserPricing();
  const db = await getAdapter();
  db.transaction(() => {
    if (!model) {
      db.run(`DELETE FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
      return;
    }
    const row = db.get(`SELECT value FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
    const current = row ? (parseJson(row.value, {}) || {}) : {};
    delete current[model];
    if (Object.keys(current).length === 0) {
      db.run(`DELETE FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
    } else {
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES('pricing', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [provider, stringifyJson(current)]
      );
    }
  });
  invalidate();
  return await getUserPricing();
}

export async function resetAllPricing() {
  await pricingKv.clear();
  invalidate();
  return {};
}
