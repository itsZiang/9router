/**
 * Combo structure resolution extracted from combo.ts.
 *
 * Runtime-step normalization, nested-combo / DAG expansion, weighted/direct
 * target resolution, and request-compatibility filtering moved out of the
 * combo.ts god-file (Quality Gate v2 / Fase 9). Logic unchanged; the public
 * entry points (resolveComboTargets, resolveNestedComboTargets, getComboFromData,
 * getComboModelsFromData, validateComboDAG, resolveNestedComboModels,
 * filterTargetsByRequestCompatibility) are re-exported from combo.ts for the
 * ~20 external consumers (chatCore.ts, the /api/combos routes, embeddings, etc.).
 * No barrel import — depends only on sibling leaves.
 */

import { getModelContextLimit } from "../../stubs/lib/modelCapabilities";
import { getComboModelString, normalizeComboStep } from "../../stubs/lib/combos/steps";
import { estimateTokens } from "../contextManager";
import { getResolvedModelCapabilities } from "../modelCapabilities";
import { parseModel } from "../model";
import { dedupeTargetsByExecutionKey, isRecord } from "./comboData";
import { getTargetProvider, MAX_COMBO_DEPTH } from "./comboPredicates";
import { normalizeModelEntry, orderTargetsForWeightedFallback, selectWeightedTarget } from "./targetSorters";
function toTrimmedString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
function toComboLike(combo) {
  return {
    ...combo,
    id: toTrimmedString(combo.id) || undefined,
    name: toTrimmedString(combo.name) || "",
    models: Array.isArray(combo.models) ? combo.models : [],
    config: isRecord(combo.config) ? combo.config : null,
    autoConfig: isRecord(combo.autoConfig) ? combo.autoConfig : null,
    context_cache_protection: typeof combo.context_cache_protection === "boolean" || typeof combo.context_cache_protection === "number" ? combo.context_cache_protection : undefined,
    system_message: typeof combo.system_message === "string" ? combo.system_message : null
  };
}
function getCombosArray(allCombos) {
  const combos = Array.isArray(allCombos) ? allCombos : allCombos?.combos || [];
  return combos.map(combo => toComboLike(combo));
}
function buildExecutionKey(path, stepId) {
  return [...path, stepId].join(">");
}
function normalizeRuntimeStep(entry, comboName, index, allCombos, path = []) {
  const step = normalizeComboStep(entry, {
    comboName,
    index,
    allCombos
  });
  if (!step) return null;
  const executionKey = buildExecutionKey(path, step.id);
  const label = typeof step.label === "string" ? step.label : null;
  const weight = step.weight || 0;
  if (step.kind === "combo-ref") {
    return {
      kind: "combo-ref",
      stepId: step.id,
      executionKey,
      comboName: step.comboName,
      weight,
      label
    };
  }
  const modelStr = getComboModelString(step);
  if (!modelStr) return null;
  return {
    kind: "model",
    stepId: step.id,
    executionKey,
    modelStr,
    provider: getTargetProvider(modelStr, step.providerId),
    providerId: step.providerId || null,
    connectionId: step.connectionId || null,
    // #3266: a per-step account allowlist scopes round-robin/weighted selection
    // to a subset of the provider's connections. This is the second writer of
    // `allowedConnectionIds` (tag routing is the first); both feed the existing
    // credential-selection filter in auth.ts.
    ...(Array.isArray(step.allowedConnectionIds) && step.allowedConnectionIds.length > 0 ? {
      allowedConnectionIds: step.allowedConnectionIds
    } : {}),
    weight,
    label
  };
}
function getDirectComboTargets(combo) {
  return getOrderedTopLevelRuntimeSteps(combo, null).filter(entry => entry?.kind === "model");
}
function getTopLevelRuntimeSteps(combo, allCombos, path = []) {
  return (combo.models || []).map((entry, index) => normalizeRuntimeStep(entry, combo.name, index, allCombos, path)).filter(entry => entry !== null);
}
function getCompositeTierStepOrder(combo) {
  const compositeTiers = isRecord(combo?.config) ? combo.config.compositeTiers : null;
  if (!isRecord(compositeTiers)) return [];
  const defaultTier = toTrimmedString(compositeTiers.defaultTier);
  const tiers = isRecord(compositeTiers.tiers) ? compositeTiers.tiers : null;
  if (!defaultTier || !tiers) return [];
  const orderedStepIds = [];
  const visitedTiers = new Set();
  const seenStepIds = new Set();
  const tierEntries = new Map(Object.entries(tiers).map(([tierName, rawTier]) => {
    if (!isRecord(rawTier)) return null;
    const normalizedTierName = toTrimmedString(tierName);
    const stepId = toTrimmedString(rawTier.stepId);
    const fallbackTier = toTrimmedString(rawTier.fallbackTier);
    if (!normalizedTierName || !stepId) return null;
    return [normalizedTierName, {
      stepId,
      fallbackTier
    }];
  }).filter(entry => entry !== null));
  let currentTier = defaultTier;
  while (currentTier && tierEntries.has(currentTier) && !visitedTiers.has(currentTier)) {
    visitedTiers.add(currentTier);
    const entry = tierEntries.get(currentTier);
    if (!entry) break;
    if (!seenStepIds.has(entry.stepId)) {
      orderedStepIds.push(entry.stepId);
      seenStepIds.add(entry.stepId);
    }
    currentTier = entry.fallbackTier;
  }
  for (const entry of tierEntries.values()) {
    if (!seenStepIds.has(entry.stepId)) {
      orderedStepIds.push(entry.stepId);
      seenStepIds.add(entry.stepId);
    }
  }
  return orderedStepIds;
}
function hasCompositeTierRuntimeOrder(combo) {
  return getCompositeTierStepOrder(combo).length > 0;
}
function orderRuntimeStepsByCompositeTiers(steps, combo) {
  const orderedStepIds = getCompositeTierStepOrder(combo);
  if (orderedStepIds.length === 0) return steps;
  const byStepId = new Map(steps.map(step => [step.stepId, step]));
  const seen = new Set();
  const ordered = [];
  for (const stepId of orderedStepIds) {
    const step = byStepId.get(stepId);
    if (!step || seen.has(step.stepId)) continue;
    ordered.push(step);
    seen.add(step.stepId);
  }
  for (const step of steps) {
    if (seen.has(step.stepId)) continue;
    ordered.push(step);
    seen.add(step.stepId);
  }
  return ordered;
}
function getOrderedTopLevelRuntimeSteps(combo, allCombos, path = []) {
  return orderRuntimeStepsByCompositeTiers(getTopLevelRuntimeSteps(combo, allCombos, path), combo);
}
function expandRuntimeStep(step, allCombos, visited = new Set(), depth = 0, path = [], maxDepth = MAX_COMBO_DEPTH) {
  if (step.kind === "model") return [step];
  if (depth > maxDepth) return [];
  const combos = getCombosArray(allCombos);
  const nestedCombo = combos.find(combo => combo.name === step.comboName);
  if (!nestedCombo || visited.has(step.comboName)) return [];
  return resolveNestedComboTargets(nestedCombo, combos, new Set(visited), depth + 1, [...path, step.stepId], maxDepth);
}
export function resolveNestedComboTargets(combo, allCombos, visited = new Set(), depth = 0, path = [], maxDepth = MAX_COMBO_DEPTH) {
  const directTargets = (combo.models || []).map((entry, index) => normalizeRuntimeStep(entry, combo.name, index, null, path)).filter(entry => entry?.kind === "model");
  if (depth > maxDepth) return directTargets;
  if (visited.has(combo.name)) return [];
  visited.add(combo.name);
  const runtimeSteps = getOrderedTopLevelRuntimeSteps(combo, allCombos, path);
  const resolved = [];
  for (const step of runtimeSteps) {
    if (step.kind === "combo-ref") {
      resolved.push(...expandRuntimeStep(step, allCombos, new Set(visited), depth, path, maxDepth));
      continue;
    }
    resolved.push(step);
  }
  return resolved;
}

/**
 * Get combo models from combos data (for open-sse standalone use)
 * @param {string} modelStr - Model string to check
 * @param {Array|Object} combosData - Array of combos or object with combos
 * @returns {Object|null} Full combo object or null if not a combo
 */
export function getComboFromData(modelStr, combosData) {
  const combos = getCombosArray(combosData);
  const combo = combos.find(c => c.name === modelStr);
  if (combo?.models && combo.models.length > 0) {
    return combo;
  }
  return null;
}

/**
 * Legacy: Get combo models as string array (backward compat)
 */
export function getComboModelsFromData(modelStr, combosData) {
  const combo = getComboFromData(modelStr, combosData);
  if (!combo) return null;
  return combo.models.map(m => normalizeModelEntry(m).model);
}

/**
 * Validate combo DAG — detect circular references and enforce max depth
 * @param {string} comboName - Name of the combo to validate
 * @param {Array} allCombos - All combos in the system
 * @param {Set} [visited] - Set of already visited combo names (for cycle detection)
 * @param {number} [depth] - Current depth level
 * @throws {Error} If circular reference or max depth exceeded
 */
export function validateComboDAG(comboName, allCombos, visited = new Set(), depth = 0, maxDepth = MAX_COMBO_DEPTH) {
  if (depth > maxDepth) {
    throw new Error(`Max combo nesting depth (${maxDepth}) exceeded at "${comboName}"`);
  }
  if (visited.has(comboName)) {
    throw new Error(`Circular combo reference detected: ${comboName}`);
  }
  visited.add(comboName);
  const combos = getCombosArray(allCombos);
  const combo = combos.find(c => c.name === comboName);
  if (!combo?.models) return;
  for (const entry of combo.models) {
    const modelName = normalizeModelEntry(entry).model;
    // Check if this model name is itself a combo (not a provider/model pattern)
    const nestedCombo = combos.find(c => c.name === modelName);
    if (nestedCombo) {
      validateComboDAG(modelName, combos, new Set(visited), depth + 1, maxDepth);
    }
  }
}

/**
 * Resolve nested combos by expanding inline to a flat model list
 * Respects max depth and detects cycles
 * @param {Object} combo - The combo object
 * @param {Array} allCombos - All combos in the system
 * @param {Set} [visited] - For cycle detection
 * @param {number} [depth] - Current depth
 * @returns {Array} Flat array of model strings
 */
export function resolveNestedComboModels(combo, allCombos, visited = new Set(), depth = 0, maxDepth = MAX_COMBO_DEPTH) {
  if (depth > maxDepth) return combo.models.map(m => normalizeModelEntry(m).model);
  if (visited.has(combo.name)) return []; // cycle safety
  visited.add(combo.name);
  const combos = getCombosArray(allCombos);
  const resolved = [];
  for (const entry of combo.models || []) {
    const modelName = normalizeModelEntry(entry).model;
    const nestedCombo = combos.find(c => c.name === modelName);
    if (nestedCombo) {
      // Recursively expand the nested combo
      const nested = resolveNestedComboModels(nestedCombo, combos, new Set(visited), depth + 1, maxDepth);
      resolved.push(...nested);
    } else {
      resolved.push(modelName);
    }
  }
  return resolved;
}

/**
 * Sort models by context window size (largest first) for context-optimized strategy.
 * Uses models.dev synced capabilities to get context limits.
 * @param {Array<string>} models - Model strings in "provider/model" format
 * @returns {Array<string>} Sorted model strings (largest context first)
 */
function sortModelsByContextSize(models) {
  const withContext = models.map(modelStr => {
    return {
      modelStr,
      context: getModelContextLimitForModelString(modelStr) ?? 0
    };
  });
  withContext.sort((a, b) => b.context - a.context);
  return withContext.map(e => e.modelStr);
}
export function getModelContextLimitForModelString(modelStr) {
  const parsed = parseModel(modelStr);
  const provider = parsed.provider || parsed.providerAlias || "unknown";
  const model = parsed.model || modelStr;
  return getModelContextLimit(provider, model);
}
function getPositiveTokenCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.ceil(count) : 0;
}
function requestRequiresTools(body) {
  if (Array.isArray(body.tools) && body.tools.length > 0) return true;
  if (Array.isArray(body.functions) && body.functions.length > 0) return true;
  return false;
}
function requestRequiresStructuredOutput(body) {
  const responseFormat = isRecord(body.response_format) ? body.response_format : null;
  const type = typeof responseFormat?.type === "string" ? responseFormat.type : null;
  return type === "json_object" || type === "json_schema";
}
function estimateRequestInputTokens(body) {
  const estimatePayload = {};
  for (const key of ["messages", "input", "tools", "functions", "response_format"]) {
    if (body[key] !== undefined) estimatePayload[key] = body[key];
  }
  return Object.keys(estimatePayload).length > 0 ? estimateTokens(estimatePayload) : 0;
}
function valueContainsImagePart(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return false;
  if (typeof value === "string") return value.startsWith("data:image/");
  if (Array.isArray(value)) return value.some(entry => valueContainsImagePart(entry, depth + 1));
  if (!isRecord(value)) return false;
  const type = typeof value.type === "string" ? value.type.toLowerCase() : null;
  if (type === "image" || type === "image_url" || type === "input_image") return true;
  if ("image_url" in value || "input_image" in value) return true;
  const source = isRecord(value.source) ? value.source : null;
  const mediaType = typeof source?.media_type === "string" ? source.media_type.toLowerCase() : "";
  if (mediaType.startsWith("image/")) return true;
  return Object.values(value).some(entry => valueContainsImagePart(entry, depth + 1));
}
function deriveRequestCompatibilityRequirements(body) {
  const estimatedInputTokens = estimateRequestInputTokens(body);
  const requestedOutputTokens = Math.max(getPositiveTokenCount(body.max_tokens), getPositiveTokenCount(body.max_completion_tokens));
  return {
    requiresTools: requestRequiresTools(body),
    requiresVision: valueContainsImagePart(body.messages) || valueContainsImagePart(body.input),
    requiresStructuredOutput: requestRequiresStructuredOutput(body),
    estimatedInputTokens,
    requestedOutputTokens,
    requiredContextTokens: estimatedInputTokens + requestedOutputTokens
  };
}
function exceedsKnownOutputLimit(requestedOutputTokens, maxOutputTokens) {
  if (requestedOutputTokens <= 0 || maxOutputTokens === null) return false;
  return maxOutputTokens < requestedOutputTokens;
}
function getTargetCompatibilityFailures(target, requirements) {
  const capabilities = getResolvedModelCapabilities(target.modelStr);
  const failures = [];
  if (requirements.requiresTools && (capabilities.supportsTools === false || !capabilities.toolCalling)) {
    failures.push("tools");
  }

  // For a request that carries an image, only route to a target whose vision
  // support is *confirmed* (`=== true`). Treat `false` AND `null` (unknown) as
  // incompatible: an unknown-capability model receiving the image is exactly how
  // a text-only model (e.g. ministral) ended up answering "image not provided".
  // The caller keeps all targets when none qualify, so combos with no
  // confirmed-vision member still behave as before.
  if (requirements.requiresVision && capabilities.supportsVision !== true) {
    failures.push("vision");
  }
  if (requirements.requiresStructuredOutput && capabilities.structuredOutput === false) {
    failures.push("structured_output");
  }
  if (exceedsKnownOutputLimit(requirements.requestedOutputTokens, capabilities.maxOutputTokens)) {
    failures.push("output_tokens");
  }
  const contextLimit = capabilities.maxInputTokens ?? capabilities.contextWindow ?? null;
  if (requirements.requiredContextTokens > 0 && contextLimit !== null && contextLimit !== undefined && contextLimit < requirements.requiredContextTokens) {
    failures.push("context_window");
  }
  return failures;
}
export function filterTargetsByRequestCompatibility(targets, body, log, label = "Context-aware fallback") {
  if (targets.length === 0) return targets;
  const requirements = deriveRequestCompatibilityRequirements(body);
  const needsFiltering = requirements.requiresTools || requirements.requiresVision || requirements.requiresStructuredOutput || requirements.requiredContextTokens > 0;
  if (!needsFiltering) return targets;
  const rejected = [];
  const compatible = targets.filter(target => {
    const reasons = getTargetCompatibilityFailures(target, requirements);
    if (reasons.length === 0) return true;
    rejected.push({
      target,
      reasons
    });
    return false;
  });
  if (compatible.length === targets.length) return targets;
  if (compatible.length === 0) {
    log.warn("COMBO", `${label}: all ${targets.length} targets were filtered by request requirements; preserving strategy order`);
    log.debug?.("COMBO", `${label}: rejected targets ${rejected.map(entry => `${entry.target.modelStr}(${entry.reasons.join("+")})`).join(", ")}`);
    return targets;
  }
  log.info("COMBO", `${label}: kept ${compatible.length}/${targets.length} targets for request requirements`);
  log.debug?.("COMBO", `${label}: rejected targets ${rejected.map(entry => `${entry.target.modelStr}(${entry.reasons.join("+")})`).join(", ")}`);
  return compatible;
}
export function sortTargetsByContextSize(targets) {
  const hasKnownContext = targets.some(target => getModelContextLimitForModelString(target.modelStr) != null);
  if (!hasKnownContext) return targets;
  const orderedModels = sortModelsByContextSize(targets.map(target => target.modelStr));
  const byModel = new Map();
  for (const target of targets) {
    const queue = byModel.get(target.modelStr) || [];
    queue.push(target);
    byModel.set(target.modelStr, queue);
  }
  return orderedModels.map(modelStr => {
    const queue = byModel.get(modelStr);
    return queue?.shift() || null;
  }).filter(target => target !== null);
}
export function resolveComboTargets(combo, allCombos, maxDepth = MAX_COMBO_DEPTH) {
  return allCombos ? resolveNestedComboTargets(combo, allCombos, new Set(), 0, [], maxDepth) : getDirectComboTargets(combo);
}
export function resolveComboRuntimeUnits(combo, allCombos, mode, maxDepth = MAX_COMBO_DEPTH) {
  if (mode === "flatten" || !allCombos) return resolveComboTargets(combo, allCombos, maxDepth);
  validateComboDAG(combo.name, allCombos, new Set(), 0, maxDepth);
  return getOrderedTopLevelRuntimeSteps(combo, allCombos);
}
export function resolveWeightedStepGroups(combo, allCombos) {
  return getOrderedTopLevelRuntimeSteps(combo, allCombos).map(step => ({
    step,
    targets: !allCombos ? step.kind === "model" ? [step] : [] : expandRuntimeStep(step, allCombos, new Set([combo.name]))
  })).filter(group => group.targets.length > 0);
}
export function resolveWeightedTargets(combo, allCombos, preferredExecutionKey = null, eligibleExecutionKeys = null, stepGroups) {
  const topLevelSteps = getOrderedTopLevelRuntimeSteps(combo, allCombos).filter(step => eligibleExecutionKeys ? eligibleExecutionKeys.has(step.executionKey) : true);
  if (topLevelSteps.length === 0) {
    return {
      orderedTargets: [],
      selectedStep: null,
      orderedSteps: []
    };
  }
  const preferredStep = preferredExecutionKey ? topLevelSteps.find(step => step.executionKey === preferredExecutionKey) || null : null;
  const selectedStep = preferredStep || selectWeightedTarget(topLevelSteps);
  if (!selectedStep) {
    return {
      orderedTargets: [],
      selectedStep: null,
      orderedSteps: []
    };
  }
  const orderedSteps = orderTargetsForWeightedFallback(topLevelSteps, selectedStep.executionKey, hasCompositeTierRuntimeOrder(combo));
  const targetsByStep = new Map((stepGroups || resolveWeightedStepGroups(combo, allCombos)).map(group => [group.step.executionKey, group.targets]));
  const expandedTargets = orderedSteps.flatMap(step => targetsByStep.get(step.executionKey) || []);
  return {
    orderedTargets: dedupeTargetsByExecutionKey(expandedTargets),
    selectedStep,
    orderedSteps
  };
}