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
 * Three sources of model IDs:
 *   1. Known providers (in PROVIDER_MODELS) → static catalog (or enabledModels
 *      when present) ∪ customModels (user-added) ∪ modelAliases (alias-mapped).
 *      This matches /v1/models so newly added models on known providers (e.g.
 *      a Gemini release not yet in the catalog) appear on the pricing page.
 *   2. Custom openai/anthropic-compatible providers (passthrough) →
 *      conn.providerSpecificData.enabledModels (user-curated) ∪ usageHistory
 *
 * IMPORTANT: providerIds uses ALIASES (cc, cx, gh, ...) for known OAuth providers
 * because PROVIDER_PRICING is keyed by alias. conn.provider stores the provider ID
 * (claude, codex, github, ...), so we resolve via PROVIDER_ID_TO_ALIAS.
 * Custom-compatible provider IDs are used verbatim (they are their own keys).
 *
 * Returns:
 *   providerIds: Set     — aliases (known) + ids (custom)
 *   providerModelsMap    — {alias|id: [modelId, ...]} for UI sections + filter dropdown
 *   providerNames        — {alias|id: displayName} for UI labels (dropdown + headers)
 */
async function getEnabledProviderInfo() {
  try {
    const { getProviderConnections } = await import("./connectionsRepo.js");
    const conns = await getProviderConnections({ isActive: true });
    if (!conns.length) {
      return { providerIds: new Set(), providerModelsMap: {}, providerNames: {} };
    }

    const { PROVIDER_MODELS, PROVIDER_ID_TO_ALIAS } = await import("open-sse/config/providerModels.js");
    const { AI_PROVIDERS, isOpenAICompatibleProvider, isAnthropicCompatibleProvider } =
      await import("@/shared/constants/providers.js");
    // Pull user-added custom models + alias mappings so newly added models on
    // known providers (e.g. a new Gemini release not yet in PROVIDER_MODELS)
    // also appear on the pricing page — matches /v1/models behaviour.
    const { getCustomModels, getModelAliases } = await import("./aliasRepo.js");
    let customModels = [];
    let modelAliases = {};
    try {
      customModels = await getCustomModels();
    } catch { /* table may not exist yet */ }
    try {
      modelAliases = await getModelAliases();
    } catch { /* table may not exist yet */ }

    const providerIds = new Set();
    const providerModelsMap = {};
    const providerNames = {};
    const passthroughIds = [];

    for (const c of conns) {
      // Resolve provider id → alias for known OAuth providers (claude→cc, codex→cx, ...)
      // Custom-compatible & API-key providers use their id as alias.
      const alias = PROVIDER_ID_TO_ALIAS[c.provider] || c.provider;
      const models = PROVIDER_MODELS[alias];

      if (models) {
        // Known provider → start from fixed model list (or user-curated
        // enabledModels when present), then augment with custom models and
        // alias-mapped models — mirrors /v1/models so the pricing page shows
        // every model the user can actually route to.
        providerIds.add(alias);
        providerNames[alias] = AI_PROVIDERS[c.provider]?.name || alias;

        const enabled = c.providerSpecificData?.enabledModels;
        const baseIds = (Array.isArray(enabled) && enabled.length)
          ? enabled.filter(id => typeof id === "string" && id.trim())
          : models.map(m => m.id);

        const modelSet = new Set(baseIds);

        // User-added custom models for this provider
        for (const cm of customModels) {
          if (!cm?.id || (cm.type && cm.type !== "llm")) continue;
          if (cm.providerAlias === alias || cm.providerAlias === c.provider) {
            modelSet.add(String(cm.id).trim());
          }
        }

        // Alias-mapped models for this provider
        for (const fullModel of Object.values(modelAliases)) {
          if (typeof fullModel !== "string" || !fullModel.includes("/")) continue;
          if (fullModel.startsWith(`${alias}/`) || fullModel.startsWith(`${c.provider}/`)) {
            const modelId = fullModel.slice(fullModel.indexOf("/") + 1);
            if (modelId) modelSet.add(modelId);
          }
        }

        providerModelsMap[alias] = [...modelSet];
      } else if (isOpenAICompatibleProvider(c.provider) || isAnthropicCompatibleProvider(c.provider)) {
        // Custom openai/anthropic-compatible → passthrough
        passthroughIds.push(c.provider);
        // Display name: prefer the node name carried on the connection (set at
        // connection creation in /api/providers POST), then the connection name,
        // then the raw provider id.
        providerNames[c.provider] =
          c.providerSpecificData?.nodeName || c.name || c.provider;
        // Prefer the user-curated enabledModels list (saved at providers/[id]/page.new.js)
        const enabled = c.providerSpecificData?.enabledModels;
        if (Array.isArray(enabled) && enabled.length) {
          providerModelsMap[c.provider] = [];
          for (const modelId of enabled) {
            if (typeof modelId !== "string" || !modelId.trim()) continue;
            if (!providerModelsMap[c.provider].includes(modelId)) {
              providerModelsMap[c.provider].push(modelId);
            }
          }
        }
      }
      // Truly unknown providers → silently ignored
    }

    // For custom passthrough providers without an enabledModels list (or to augment it),
    // pull actually-used models from usage history. Only count successful requests
    // (status='ok') — failed/garbage model names that never completed a request
    // should not appear in pricing.
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
      providerIds,
      providerModelsMap,
      providerNames,
    };
  } catch {
    return { providerIds: new Set(), providerModelsMap: {}, providerNames: {} };
  }
}

export async function getPricing() {
  const now = Date.now();
  if (cache.value && cache.expiresAt > now) return cache.value;

  const userPricing = await getUserPricing();
  const { getPricingForModel: resolveBasePrice } = await import("@/shared/constants/pricing.js");
  const { providerModelsMap, providerNames } = await getEnabledProviderInfo();
  const merged = {};

  // "*" holds ONLY user-set global overrides (applies to all providers via
  // getPricingForModel). Deliberately NOT seeded from the catalog so each enabled
  // provider gets its own clearly-labeled section instead of being lumped into
  // one giant "Default Pricing" bucket. Renders only when non-empty.
  if (userPricing["*"]) {
    merged["*"] = { ...userPricing["*"] };
  }

  // One section per enabled provider (known alias OR custom id). Seed each model
  // with its effective baseline price from the constants chain
  // (PROVIDER_PRICING → MODEL_PRICING → PATTERN), falling back to zero stubs for
  // models not in the catalog (typical for custom-compatible providers).
  for (const [providerKey, modelIdList] of Object.entries(providerModelsMap)) {
    if (!merged[providerKey]) merged[providerKey] = {};
    for (const modelId of modelIdList) {
      const base = resolveBasePrice(providerKey, modelId)
        || { input: 0, output: 0, cached: 0, reasoning: 0, cache_creation: 0 };
      merged[providerKey][modelId] = { ...base };
    }
  }

  // Apply user overrides on top (provider-specific + global "*")
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

  // Attach provider→model mapping for UI filtering (keys match rendered section keys)
  merged._providerModels = providerModelsMap;
  // Attach provider→display name map for UI labels (dropdown + section headers)
  merged._providerNames = providerNames;

  cache = { value: merged, expiresAt: now + CACHE_TTL_MS };
  return merged;
}

export async function getPricingForModel(provider, model) {
  if (!model) return null;
  const userPricing = await getUserPricing();

  // Resolve alias for known OAuth providers (claude→cc, codex→cx, github→gh, ...)
  // because the pricing UI stores overrides under the ALIAS key (matching
  // providerModelsMap), but the cost calculator receives the provider ID.
  let alias = provider;
  try {
    const { PROVIDER_ID_TO_ALIAS } = await import("open-sse/config/providerModels.js");
    alias = PROVIDER_ID_TO_ALIAS[provider] || provider;
  } catch { /* open-sse unavailable */ }

  // 1. Provider-specific user override — check both id and alias keys
  if (provider && userPricing[provider]?.[model]) return userPricing[provider][model];
  if (alias !== provider && userPricing[alias]?.[model]) return userPricing[alias][model];
  // 2. Generic model override from "*" provider (applies to all providers)
  if (userPricing["*"]?.[model]) return userPricing["*"][model];
  // 3. Built-in constants chain: PROVIDER_PRICING → MODEL_PRICING → PATTERN_PRICING
  //    Pass alias (not id) since PROVIDER_PRICING is keyed by alias (e.g. "gh").
  const { getPricingForModel: resolveConst } = await import("@/shared/constants/pricing.js");
  return resolveConst(alias, model);
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
