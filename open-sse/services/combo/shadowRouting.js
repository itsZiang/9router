/**
 * Combo shadow-routing helpers extracted from combo.ts.
 *
 * Shadow routing mirrors a sampled fraction of production traffic to extra
 * targets (fire-and-forget) to compare behavior without affecting the real
 * response. Moved out of the combo.ts god-file (Quality Gate v2 / Fase 9) —
 * logic unchanged; `resolveShadowTargets` and `scheduleShadowRouting` are
 * re-exported from combo.ts for backward compatibility and used by
 * handleComboChat / handleRoundRobinCombo (which stay in combo.ts).
 *
 * NOTE: `resolveNestedComboTargets` lives in combo/comboStructure.ts (extracted
 * in the same Fase 9 split). It is only invoked at request time inside
 * `resolveShadowTargets`, never during module init.
 */

import { secureRandomFloat } from "../../stubs/shared/utils/secureRandom";
import { recordComboShadowRequest } from "../comboMetrics";
import { isRecord } from "./comboData";
import { resolveNestedComboTargets } from "./comboStructure";
import { toRecordedTarget } from "./comboPredicates";
function normalizeShadowRoutingConfig(config) {
  const raw = isRecord(config.shadowRouting) ? config.shadowRouting : {};
  const sampleRate = Number(raw.sampleRate ?? 1);
  const maxTargets = Number(raw.maxTargets ?? 2);
  const timeoutMs = Number(raw.timeoutMs ?? 30000);
  return {
    enabled: raw.enabled === true,
    targets: Array.isArray(raw.targets) ? raw.targets : [],
    sampleRate: Number.isFinite(sampleRate) ? Math.max(0, Math.min(1, sampleRate)) : 1,
    maxTargets: Number.isFinite(maxTargets) ? Math.max(1, Math.min(10, Math.floor(maxTargets))) : 2,
    timeoutMs: Number.isFinite(timeoutMs) ? Math.max(1000, Math.min(120000, Math.floor(timeoutMs))) : 30000
  };
}
export function resolveShadowTargets(combo, config, allCombos) {
  const shadowConfig = normalizeShadowRoutingConfig(config);
  if (!shadowConfig.enabled || shadowConfig.targets.length === 0) return [];
  if (shadowConfig.sampleRate <= 0 || secureRandomFloat() > shadowConfig.sampleRate) return [];
  const shadowCombo = {
    ...combo,
    name: `${combo.name}:shadow`,
    models: shadowConfig.targets
  };
  return resolveNestedComboTargets(shadowCombo, allCombos, new Set([combo.name]), 0, ["shadow"]).slice(0, shadowConfig.maxTargets).map(target => ({
    ...target,
    trafficType: "shadow"
  }));
}
async function drainShadowResponse(response) {
  try {
    if (!response.body) return;
    await response.arrayBuffer();
  } catch {
    // Shadow draining is best-effort and must never affect the production response.
  }
}
function withTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Shadow route timed out")), timeoutMs);
    promise.then(value => {
      clearTimeout(timer);
      resolve(value);
    }, error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
function cloneRequestBodyForShadowRouting(body) {
  if (typeof structuredClone === "function") {
    return structuredClone(body);
  }
  return JSON.parse(JSON.stringify(body));
}
export function scheduleShadowRouting(combo, config, body, targets, handleSingleModel, isModelAvailable, strategy, log) {
  if (targets.length === 0) return;
  const shadowConfig = normalizeShadowRoutingConfig(config);
  let shadowBaseBody;
  try {
    shadowBaseBody = cloneRequestBodyForShadowRouting(body);
  } catch (error) {
    log.warn("COMBO", "Shadow routing skipped: failed to clone request body", {
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }
  const run = async () => {
    await Promise.all(targets.map(async target => {
      const startedAt = Date.now();
      try {
        const shadowBody = {
          ...cloneRequestBodyForShadowRouting(shadowBaseBody),
          model: target.modelStr,
          stream: false
        };
        if (isModelAvailable) {
          const available = await isModelAvailable(target.modelStr, target);
          if (!available) {
            recordComboShadowRequest(combo.name, target.modelStr, {
              success: false,
              latencyMs: Date.now() - startedAt,
              target: toRecordedTarget(target)
            });
            log.info("COMBO", `Shadow target skipped (unavailable): ${target.modelStr}`);
            return;
          }
        }
        const response = await withTimeout(handleSingleModel(shadowBody, target.modelStr, {
          ...target,
          failoverBeforeRetry: true,
          trafficType: "shadow"
        }), shadowConfig.timeoutMs);
        await drainShadowResponse(response.clone());
        recordComboShadowRequest(combo.name, target.modelStr, {
          success: response.ok,
          latencyMs: Date.now() - startedAt,
          target: toRecordedTarget(target)
        });
        log.info("COMBO", `Shadow target ${target.modelStr} completed with status ${response.status} (${strategy})`);
      } catch (error) {
        recordComboShadowRequest(combo.name, target.modelStr, {
          success: false,
          latencyMs: Date.now() - startedAt,
          target: toRecordedTarget(target)
        });
        log.warn("COMBO", `Shadow target ${target.modelStr} failed`, {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }));
  };
  setTimeout(() => void run(), 0);
}