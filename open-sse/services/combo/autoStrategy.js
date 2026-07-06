/**
 * Auto-combo scoring, intent extraction, request-tag routing, candidate-pool
 * expansion and the quota-soft execution-candidate registry — extracted from
 * combo.ts (Quality Gate v2 / Fase 9, combo split D8 — reduced).
 *
 * Logic is unchanged (byte-identical move); the moved public symbols
 * (QUOTA_SOFT_DEPRIORITIZE_FACTOR, setCandidateQuotaSoftPenalty, scoreAutoTargets,
 * expandAutoComboCandidatePool) are re-exported from combo.ts for backward
 * compatibility — including chatCore.ts's dynamic `import("../services/combo")`
 * which reads setCandidateQuotaSoftPenalty + QUOTA_SOFT_DEPRIORITIZE_FACTOR.
 *
 * The _activeExecutionCandidates registry Map MUST stay a single instance, so it
 * and its three mutators live together here.
 *
 * NOTE: buildAutoCandidates (and its two private-only helpers
 * calculateTargetContextAffinity / getBootstrapLatencyMs) deliberately stay in
 * combo.ts — it is the sole user of the internal reset-window helpers
 * (resolveResetWindowConfig / fetchResetAwareQuotaWithCache /
 * calculateResetWindowAffinity), so keeping it there avoids a combo ⇄ autoStrategy
 * import cycle. This module never imports from the combo barrel.
 */

import { isRecord } from "./comboData";
import { extractSessionAffinityKey } from "@/sse/services/auth";
import { DEFAULT_INTENT_CONFIG } from "../intentClassifier";
import { getTaskFitness } from "../autoCombo/taskFitness";
import { calculateFactors, calculateScore } from "../autoCombo/scoring";
import { getProviderConnections } from "../../stubs/lib/db/providers";
import { getProviderModels } from "../../config/providerModels";
import { getConnectionRoutingTags, matchesRoutingTags, resolveRequestRoutingTags } from "../../stubs/domain/tagRouter";

// Quota Share soft-policy deprioritization factor (B17).
// When a candidate has quotaSoftPenalty === true, its auto-combo score is
// multiplied by this factor so over-quota-soft keys are de-prioritized
// without being fully blocked (that is done by "hard" policy).
// Override via QUOTA_SOFT_DEPRIORITIZE_FACTOR env var (range 0..1, default 0.7).
export const QUOTA_SOFT_DEPRIORITIZE_FACTOR = Number(process.env.QUOTA_SOFT_DEPRIORITIZE_FACTOR ?? "0.7");

// #4540: Status soft-deprioritization factor.
// When the quota-preflight HARD cutoff is OFF (default), a candidate whose connection
// is in a terminal/transient unavailable status (credits_exhausted / rate_limited /
// banned / expired / future-dated unavailable) is NOT hard-blocked — instead its
// auto-combo score is multiplied by this factor so an exhausted provider ranks strictly
// below an otherwise-identical healthy one, without surfacing a misleading 429.
// Override via STATUS_SOFT_DEPRIORITIZE_FACTOR env var (range 0..1, default 0.5).
export const STATUS_SOFT_DEPRIORITIZE_FACTOR = Number(process.env.STATUS_SOFT_DEPRIORITIZE_FACTOR ?? "0.5");

// G2: Module-level registry of active combo execution candidates.
// Maps executionKey → Map<stepId, candidate mutable ref>.
// Populated by buildAutoCandidates registrations; cleaned up after each execution.
// This allows chatCore.ts to mark a candidate's quotaSoftPenalty flag so that
// subsequent scoring iterations (auto-combo fallback) deprioritize it.
const _activeExecutionCandidates = new Map();

/**
 * Mark a specific candidate (by comboExecutionKey + stepId) with soft quota penalty.
 * Called from chatCore.ts when enforceQuotaShare returns a "soft deprioritize" decision.
 * The flag is read on subsequent auto-combo scoring iterations (fallback chain)
 * within the same combo execution via scoreAutoTargets → QUOTA_SOFT_DEPRIORITIZE_FACTOR.
 *
 * Guards:
 * - null executionKey or stepId → no-op (non-combo or context not available).
 * - unknown executionKey → no-op (candidate not yet registered or already cleaned up).
 * - Idempotent: calling twice with the same (key, stepId, true) is safe.
 */
export function setCandidateQuotaSoftPenalty(comboExecutionKey, comboStepId, penalty) {
  if (!comboExecutionKey || !comboStepId) return;
  const byStep = _activeExecutionCandidates.get(comboExecutionKey);
  if (!byStep) return;
  const candidate = byStep.get(comboStepId);
  if (candidate) {
    candidate.quotaSoftPenalty = penalty;
  }
}

/**
 * Register candidates for a combo execution so setCandidateQuotaSoftPenalty can
 * locate them by (executionKey, stepId).
 * Each candidate object is stored by reference — mutations via setCandidateQuotaSoftPenalty
 * propagate back to the original candidate array used by scoreAutoTargets.
 * @internal — not exported; only called within combo.ts by buildAutoCandidates callers.
 */
export function _registerExecutionCandidates(candidates) {
  for (const candidate of candidates) {
    if (!candidate.executionKey) continue;
    let byStep = _activeExecutionCandidates.get(candidate.executionKey);
    if (!byStep) {
      byStep = new Map();
      _activeExecutionCandidates.set(candidate.executionKey, byStep);
    }
    byStep.set(candidate.stepId, candidate);
  }
}

/**
 * Unregister all candidates for a given execution key once the execution completes.
 * Prevents unbounded memory growth.
 * @internal — not exported; called after each handleComboChat iteration.
 */
export function _unregisterExecutionCandidates(executionKeys) {
  for (const key of executionKeys) {
    _activeExecutionCandidates.delete(key);
  }
}
function toTextContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(part => {
    if (!isRecord(part)) return "";
    if (typeof part.text === "string") return part.text;
    return "";
  }).join("\n");
}
export function extractPromptForIntent(body) {
  if (!body || typeof body !== "object") return "";
  const fromMessages = Array.isArray(body.messages) ? [...body.messages].reverse().find(m => isRecord(m) && m.role === "user") : null;
  if (isRecord(fromMessages)) return toTextContent(fromMessages.content);
  if (typeof body.input === "string") return body.input;
  if (Array.isArray(body.input)) {
    const text = body.input.map(item => {
      if (!isRecord(item)) return "";
      if (typeof item.content === "string") return item.content;
      if (typeof item.text === "string") return item.text;
      return "";
    }).filter(Boolean).join("\n");
    if (text) return text;
  }
  if (typeof body.prompt === "string") return body.prompt;
  return "";
}
export function mapIntentToTaskType(intent) {
  switch (intent) {
    case "code":
      return "coding";
    case "reasoning":
      return "analysis";
    case "simple":
      return "default";
    case "medium":
    default:
      return "default";
  }
}
function toStringArray(input) {
  if (Array.isArray(input)) {
    return input.map(v => typeof v === "string" ? v.trim() : "").filter(Boolean);
  }
  if (typeof input === "string") {
    return input.split(",").map(v => v.trim()).filter(Boolean);
  }
  return [];
}
export function getIntentConfig(settings, combo) {
  const resolvedSettings = settings || {};
  const comboAutoConfig = combo?.autoConfig || {};
  const comboConfigAuto = isRecord(combo?.config?.auto) ? combo.config.auto : {};
  const comboIntentConfig = isRecord(comboAutoConfig.intentConfig) && comboAutoConfig.intentConfig || isRecord(comboConfigAuto.intentConfig) && comboConfigAuto.intentConfig || isRecord(combo?.config?.intentConfig) && combo.config.intentConfig || {};
  return {
    ...DEFAULT_INTENT_CONFIG,
    ...comboIntentConfig,
    ...(typeof resolvedSettings.intentDetectionEnabled === "boolean" ? {
      enabled: resolvedSettings.intentDetectionEnabled
    } : {}),
    ...(Number.isFinite(Number(resolvedSettings.intentSimpleMaxWords)) ? {
      simpleMaxWords: Number(resolvedSettings.intentSimpleMaxWords)
    } : {}),
    ...(toStringArray(resolvedSettings.intentExtraCodeKeywords).length > 0 ? {
      extraCodeKeywords: toStringArray(resolvedSettings.intentExtraCodeKeywords)
    } : {}),
    ...(toStringArray(resolvedSettings.intentExtraReasoningKeywords).length > 0 ? {
      extraReasoningKeywords: toStringArray(resolvedSettings.intentExtraReasoningKeywords)
    } : {}),
    ...(toStringArray(resolvedSettings.intentExtraSimpleKeywords).length > 0 ? {
      extraSimpleKeywords: toStringArray(resolvedSettings.intentExtraSimpleKeywords)
    } : {})
  };
}
export async function applyRequestTagRouting(targets, body, log) {
  const {
    tags,
    matchMode
  } = resolveRequestRoutingTags(body);
  if (tags.length === 0 || targets.length === 0) {
    return targets;
  }
  const providerIds = Array.from(new Set(targets.map(target => target.providerId || target.provider))).filter(providerId => typeof providerId === "string" && providerId.length > 0);
  const providerConnections = new Map();
  await Promise.all(providerIds.map(async providerId => {
    try {
      const connections = await getProviderConnections({
        provider: providerId,
        isActive: true
      });
      providerConnections.set(providerId, Array.isArray(connections) ? connections : []);
    } catch (error) {
      log.warn?.("COMBO", `Tag routing failed to load connections for provider=${providerId}: ${error instanceof Error ? error.message : String(error)}`);
      providerConnections.set(providerId, []);
    }
  }));
  const filteredTargets = targets.reduce((acc, target) => {
    const providerKey = target.providerId || target.provider;
    const candidateConnections = providerConnections.get(providerKey)?.filter(connection => {
      const connectionId = typeof connection.id === "string" && connection.id.trim().length > 0 ? connection.id : null;
      if (!connectionId) return false;
      if (target.connectionId) {
        return connectionId === target.connectionId;
      }
      return true;
    }) || [];
    const matchedConnectionIds = candidateConnections.filter(connection => matchesRoutingTags(getConnectionRoutingTags(connection.providerSpecificData), tags, matchMode)).map(connection => connection.id).filter(connectionId => typeof connectionId === "string");
    if (matchedConnectionIds.length === 0) {
      return acc;
    }
    if (target.connectionId) {
      acc.push(target);
      return acc;
    }

    // #3266: when a step already carries an account allowlist, intersect it with
    // the tag-matched connections (most-restrictive wins). An empty intersection
    // means no connection satisfies both constraints, so the target is dropped —
    // the same outcome the `matchedConnectionIds.length === 0` guard above yields.
    const tagMatched = Array.from(new Set(matchedConnectionIds));
    const stepAllow = Array.isArray(target.allowedConnectionIds) ? target.allowedConnectionIds.filter(id => typeof id === "string" && id.length > 0) : null;
    const effectiveAllow = stepAllow && stepAllow.length > 0 ? tagMatched.filter(id => stepAllow.includes(id)) : tagMatched;
    if (effectiveAllow.length === 0) {
      return acc;
    }
    acc.push({
      ...target,
      allowedConnectionIds: effectiveAllow
    });
    return acc;
  }, []);
  if (filteredTargets.length === 0) {
    log.info?.("COMBO", `Tag routing matched 0/${targets.length} targets for [${tags.join(", ")}] (${matchMode}); falling back to the full target set`);
    return targets;
  }
  log.info?.("COMBO", `Tag routing matched ${filteredTargets.length}/${targets.length} targets for [${tags.join(", ")}] (${matchMode})`);
  return filteredTargets;
}
export function scoreAutoTargets(targets, candidates, taskType, weights, manifestHint) {
  const targetByExecutionKey = new Map(targets.map(target => [target.executionKey, target]));
  const activeCandidates = candidates.filter(candidate => candidate.quotaCutoffBlocked !== true);
  return activeCandidates.map(candidate => {
    const baseTarget = targetByExecutionKey.get(candidate.executionKey) || targets.find(target => target.stepId === candidate.stepId || target.provider === candidate.provider && target.modelStr === candidate.modelStr);
    if (!baseTarget) return null;
    const target = {
      ...baseTarget,
      stepId: candidate.stepId,
      executionKey: candidate.executionKey,
      modelStr: candidate.modelStr,
      provider: candidate.provider,
      connectionId: candidate.connectionId ?? baseTarget.connectionId
    };
    const factors = calculateFactors(candidate, activeCandidates, taskType ?? "general", getTaskFitness, manifestHint ?? undefined);
    let score = calculateScore(factors, weights);
    // B17: Quota Share soft-policy deprioritization
    if ("quotaSoftPenalty" in candidate && candidate.quotaSoftPenalty === true) {
      score *= QUOTA_SOFT_DEPRIORITIZE_FACTOR;
    }
    // #4540: terminal/transient connection status soft penalty (no hard block).
    // A no-fetcher exhausted provider keeps quotaRemaining=100, so without this its
    // score would tie a healthy provider's. The penalty pushes it strictly below.
    if ("statusPenalty" in candidate && candidate.statusPenalty === true) {
      score *= STATUS_SOFT_DEPRIORITIZE_FACTOR;
    }
    return {
      target,
      score
    };
  }).filter(entry => entry !== null).sort((a, b) => b.score - a.score);
}

/**
 * For an auto-combo WITHOUT an explicit `candidatePool`, broaden the eligible
 * targets to every model of every active provider connection so the router has
 * the full pool to score over. Already-present `modelStr`s are not duplicated.
 *
 * Best-effort: if loading active connections or provider models throws, the
 * explicitly-resolved targets are returned unchanged (the combo still runs).
 * Exported for unit testing. Mutates and returns `eligibleTargets`.
 */
export async function expandAutoComboCandidatePool(eligibleTargets, combo) {
  const localAutoConfig = combo?.autoConfig || (isRecord(combo?.config?.auto) ? (combo?.config).auto : null) || combo?.config || {};
  if (Array.isArray(localAutoConfig?.candidatePool) && localAutoConfig.candidatePool.length > 0) return eligibleTargets;
  try {
    const allConnections = await getProviderConnections({
      isActive: true
    });
    const providerIds = [...new Set(allConnections.map(c => c.provider).filter(p => typeof p === "string" && p.length > 0))];
    for (const providerId of providerIds) {
      const providerModels = getProviderModels(providerId);
      for (const model of providerModels) {
        const modelStr = `${providerId}/${model.id}`;
        if (!eligibleTargets.some(t => t.modelStr === modelStr)) {
          eligibleTargets.push({
            kind: "model",
            stepId: modelStr,
            executionKey: modelStr,
            provider: providerId,
            providerId: providerId,
            modelStr,
            weight: 1,
            connectionId: null,
            label: null
          });
        }
      }
    }
  } catch {
    // Best-effort candidate expansion only: if loading active connections or
    // provider models fails, fall back to the explicitly-resolved targets
    // rather than aborting the combo. The push above is the only mutation,
    // so a throw leaves eligibleTargets exactly as explicit resolution built it.
  }
  return eligibleTargets;
}

/**
 * Derive a STABLE per-conversation session key for combo context-cache pinning when
 * the client did not provide an explicit session id (#3825).
 *
 * Most OpenAI-compatible clients send no session id, so the server-side pin added by
 * #3399 (gated on `relayOptions?.sessionId`) never engaged → combos rotated every turn,
 * causing upstream prompt-cache misses, cold high-reasoning starts and intermittent
 * 504s. We reuse `extractSessionAffinityKey(body)` (the same conversation fingerprint
 * used for codex failover affinity), which hashes the first user/system message — stable
 * across turns of the same conversation and identical on turn 2 of a continued chat.
 *
 * Returns null when no stable fingerprint is available (e.g. empty body), in which case
 * the caller falls back to NO pinning — preserving prior behavior rather than guessing.
 */
export function deriveComboSessionKey(body) {
  try {
    return extractSessionAffinityKey(body) ?? null;
  } catch {
    return null;
  }
}