/**
 * Generic model search for ModelSelectModal ("Add Model to Combo" and siblings).
 *
 * Goals (provider-agnostic — works for qwen/gpt/gemini/claude/glm/kimi/...):
 * - case-insensitive
 * - multi-token AND: "qwen flash" matches "qwen38-flash-next"
 * - matches across id, display name, full value ("prefix/model-id")
 *   and provider display name / prefix / alias, so "inferx flash"
 *   scopes to the inferx provider without a separate dropdown
 * - separator-tolerant (fuzzy tier): "qwen3.8-flash" also suggests
 *   "qwen38-flash-next" (missing dot, extra "-next" suffix)
 * - exact matches rank above fuzzy ones
 *
 * Pure functions (no React) so they are unit-testable.
 */

// Characters treated as equivalent separators when normalizing.
// e.g. "qwen3.8-flash" -> "qwen38flash", "qwen/qwen3.7-flash" -> "qwenqwen37flash"
const SEPARATORS_RE = /[.\-_/:\\\s]+/g;

/**
 * Normalize a string for fuzzy comparison: lowercase + strip separators.
 * @param {unknown} s
 * @returns {string}
 */
export function normalizeSearchToken(s) {
  if (typeof s !== "string") return "";
  return s.toLowerCase().replace(SEPARATORS_RE, "");
}

/**
 * Split a raw query into tokens on whitespace AND separators (/ . - _ :).
 * Splitting "GEMINI-FLASH" into ["gemini","flash"] lets it match
 * "gemini-3.5-flash" (version in the middle); each token must still match
 * (AND), so precision is kept. Single-char tokens (e.g. "8" from "3.8")
 * only count on raw substring hits (see tokenMatchDetail).
 * @param {unknown} query
 * @returns {string[]} lowercased non-empty tokens
 */
export function splitSearchQuery(query) {
  if (typeof query !== "string") return [];
  return query.trim().toLowerCase().split(/[\s/_:.\-]+/).filter(Boolean);
}

/**
 * Build raw + normalized haystacks for one model in its provider group.
 * Raw uuid-style providerIds are intentionally excluded (users type the
 * display prefix like "inferx", not "openai-compatible-chat-<uuid>").
 * @param {{id?:string,name?:string,value?:string}} model
 * @param {{name?:string,alias?:string}} group
 * @returns {{raw:string[],norm:string[]}}
 */
export function buildModelHaystacks(model = {}, group = {}) {
  const raw = [];
  for (const field of [model.id, model.name, model.value, group.name, group.alias]) {
    if (typeof field === "string" && field.trim()) raw.push(field.toLowerCase());
  }
  const norm = raw
    .map((h) => normalizeSearchToken(h))
    .filter((h) => h.length >= 2);
  return { raw, norm };
}

/**
 * Check one token against haystacks.
 * @returns {{raw:boolean,norm:boolean}} raw=substring hit, norm=normalized hit
 */
export function tokenMatchDetail(tokenRaw, haystacks) {
  const t = (tokenRaw || "").toLowerCase();
  if (!t) return { raw: false, norm: false };
  const raw = haystacks.raw.some((h) => h.includes(t));
  const tn = normalizeSearchToken(t);
  // Single-char / empty normalized tokens would match everything — require raw.
  const norm = tn.length >= 2 && haystacks.norm.some((h) => h.includes(tn));
  return { raw, norm };
}

/**
 * Score a model against a query.
 * Tiers: 0 = full-query exact (id/name/value), 1 = all tokens raw-hit,
 * 2 = all tokens hit with >=1 normalized-only (fuzzy). No match -> null.
 * Placeholders (e.g. "inferx/model-id") never match a non-empty query.
 * @param {unknown} query
 * @param {{id?:string,name?:string,value?:string,isPlaceholder?:boolean}} model
 * @param {{name?:string,alias?:string}} group
 * @returns {{matched:boolean,tier:number,isFuzzy:boolean}}
 */
export function matchModelWithScore(query, model = {}, group = {}) {
  const tokens = splitSearchQuery(query);
  if (tokens.length === 0) return { matched: true, tier: 1, isFuzzy: false };
  if (model.isPlaceholder) return { matched: false, tier: -1, isFuzzy: false };

  const q = typeof query === "string" ? query.trim().toLowerCase() : "";
  for (const field of [model.id, model.name, model.value]) {
    if (typeof field === "string" && field.toLowerCase() === q) {
      return { matched: true, tier: 0, isFuzzy: false };
    }
  }

  const haystacks = buildModelHaystacks(model, group);
  let usedFuzzy = false;
  for (const token of tokens) {
    const { raw, norm } = tokenMatchDetail(token, haystacks);
    if (raw) continue;
    if (norm) {
      usedFuzzy = true;
      continue;
    }
    return { matched: false, tier: -1, isFuzzy: false };
  }
  return { matched: true, tier: usedFuzzy ? 2 : 1, isFuzzy: usedFuzzy };
}

/**
 * Filter + rank grouped models (shape produced by ModelSelectModal's
 * groupedModels memo: { [providerId]: { name, alias, models: [...] } }).
 * Sort per group: tier asc, then already-added first, then name alpha.
 * Groups with zero matching models are dropped.
 * @param {Record<string,{name?:string,alias?:string,models:Array}>} groupedModels
 * @param {unknown} query
 * @param {{addedValues?:string[]}} opts
 * @returns {Record<string,{name?:string,alias?:string,models:Array}>}
 */
export function filterGroupedModels(groupedModels = {}, query, opts = {}) {
  const tokens = splitSearchQuery(query);
  const added = new Set(opts.addedValues || []);
  const filtered = {};

  for (const [providerId, group] of Object.entries(groupedModels || {})) {
    const models = Array.isArray(group?.models) ? group.models : [];
    if (tokens.length === 0) {
      filtered[providerId] = {
        ...group,
        models: sortScored(
          models.map((m) => ({ model: m, tier: 1 })),
          added
        ),
      };
      continue;
    }
    const scored = [];
    for (const m of models) {
      const r = matchModelWithScore(query, m, group);
      if (r.matched) scored.push({ model: m, tier: r.tier });
    }
    if (scored.length === 0) continue;
    filtered[providerId] = { ...group, models: sortScored(scored, added) };
  }
  return filtered;
}

/**
 * @param {Array<{model:Object,tier:number}>} scored
 * @param {Set<string>} addedSet set of model.value already in the combo
 */
function sortScored(scored, addedSet) {
  return scored
    .sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      const aAdded = addedSet.has(a.model?.value);
      const bAdded = addedSet.has(b.model?.value);
      if (aAdded !== bAdded) return aAdded ? -1 : 1;
      return String(a.model?.name || "").localeCompare(String(b.model?.name || ""));
    })
    .map((s) => s.model);
}
