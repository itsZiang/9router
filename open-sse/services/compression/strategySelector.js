import { applyHardBudget } from "./hardBudget";
import { gateAdvance } from "./fidelityGateStep";
import { applyLiteCompression } from "./lite";
import { cavemanCompress } from "./caveman";
import { compressAggressive } from "./aggressive";
import { ultraCompress, ultraCompressHeuristic } from "./ultra";
import { createCompressionStats } from "./stats";
import { guardPipelineInflation } from "./pipelineGuards";
import { resolvePipelineBreakerConfig, canRunEngine, recordEngineFailure, recordEngineSuccess } from "./pipelineEngineBreaker";
import { createStackAccumulator, decideStep, mergeStackStep } from "./stackedStepCore";
import { registerBuiltinCompressionEngines } from "./engines/index";
import { getCompressionEngine, getEngineEntry } from "./engines/registry";
import { applyRtkCompression } from "./engines/rtk/index";
import { adaptBodyForCompression } from "./bodyAdapter";
import { detectCachingContext, getCacheAwareStrategy } from "./cachingAware";
import { resolveCompressionPlan } from "./resolveCompressionPlan";
import { deriveDefaultPlan } from "./deriveDefaultPlan";
import { withSource, planFromHeader, formatCompressionMeta, formatCompressionAnnotation, deriveDefaultPlanFromConfig, buildNamedComboLookup } from "./planResolution";
import { resolveAdaptivePlan } from "./adaptiveCompression/resolveAdaptivePlan";
import { resolveRiskGate, withRiskGate, withRiskGateAsync } from "./riskGate/strategyWrap";
import { withCompressionEntrypointGuards, withCompressionEntrypointGuardsAsync } from "./entrypointWrap";
import { makeMemoKey, memoLookup, memoStore, isDeterministicMode } from "./resultMemo";
export { resolveCacheAwareConfig } from "./cacheAwareConfig";

// Re-export so existing importers (resolver test + chatCore dynamic import) keep resolving.
export { planFromHeader, formatCompressionMeta, formatCompressionAnnotation, buildNamedComboLookup };

/** Named-combo map: combo id → its stacked pipeline (operator-defined profiles). */

export function checkComboOverride(config, comboId) {
  if (!comboId || !config.comboOverrides) return null;
  return config.comboOverrides[comboId] ?? null;
}
export function shouldAutoTrigger(config, estimatedTokens) {
  return config.autoTriggerTokens > 0 && estimatedTokens >= config.autoTriggerTokens;
}

/**
 * Resolves the effective compression plan (mode + derived stacked pipeline) WITHOUT
 * the caching-aware mode adjustment (that is layered on by {@link selectCompressionPlan}).
 *
 * Precedence — preserved from the historical {@link getEffectiveMode} ordering:
 *   1. master off                     → off
 *   2. routing-combo override (comboId)→ that mode (resolver honors it via ctx.comboId)
 *   3. active named profile (Phase 2)  → that combo's stacked pipeline (manual operator choice)
 *   4. auto-trigger (large prompt)     → autoTriggerMode, BEFORE the plain derived default
 *   5. derived default                 → resolveCompressionPlan (engines map → mode/pipeline)
 *
 * Step 3 is an EXPLICIT operator selection (`config.activeComboId` resolved against the
 * `combos` map): it beats auto-trigger (a manual choice outranks automatic escalation) but
 * stays below a routing-combo override (route-scoped is more specific). Step 4 mirrors the
 * historical behaviour: auto-trigger precedes the plain derived default but never a routing
 * override.
 *
 * `combos` defaults to `{}` so Phase-1 callers are unchanged; when supplied, chatCore passes
 * its DB-loaded named-combo map so the active profile can resolve here purely (no DB import).
 */
/** True when the adaptive resolver owns automatic-by-size escalation (D-C4). */
function adaptiveEnabled(config) {
  const mode = config.contextBudget?.mode;
  return mode === "floor" || mode === "replace-autotrigger";
}
function resolveBasePlan(config, comboId, estimatedTokens, combos = {}, header = null) {
  if (!config.enabled) return withSource({
    mode: "off",
    stackedPipeline: []
  }, "off");

  // Phase 3: an explicit, recognized header wins over every operator layer (Decision B).
  // The master switch above is the hard kill: a header cannot turn compression on.
  if (header) {
    const fromHeader = planFromHeader(config, header, combos);
    if (fromHeader) return fromHeader; // already tagged "request-header"
  }
  const comboMode = checkComboOverride(config, comboId);
  if (comboMode) {
    // A routing-combo "stacked" override still wants the configured stacked pipeline,
    // so route it through the resolver (which reads config.stackedPipeline for stacked).
    return withSource(resolveCompressionPlan(config, {
      comboId,
      combos
    }), "routing-override");
  }

  // Active profile: an EXPLICIT operator choice. Resolves regardless of enginesExplicit and
  // above auto-trigger (manual choice beats automatic escalation), but below a routing-combo
  // override (route-scoped is more specific).
  if (config.activeComboId && combos[config.activeComboId]) {
    return withSource({
      mode: "stacked",
      stackedPipeline: combos[config.activeComboId]
    }, "active-profile");
  }
  if (!adaptiveEnabled(config) && shouldAutoTrigger(config, estimatedTokens)) {
    const mode = config.autoTriggerMode ?? "lite";
    return withSource(mode === "stacked" ? {
      mode,
      stackedPipeline: config.stackedPipeline ?? []
    } : {
      mode,
      stackedPipeline: []
    }, "auto-trigger");
  }
  const plan = deriveDefaultPlanFromConfig(config, comboId, combos);
  return withSource(plan, plan.mode === "off" ? "off" : "default");
}

/**
 * True when the EXPLICITLY-configured engines map (panel-saved) derives a multi-engine
 * stacked pipeline. chatCore uses this to know the panel's derived pipeline is authoritative
 * and the legacy default-combo fallback must NOT override it. Returns false for legacy
 * (non-explicit) installs so their historical default-combo path is preserved untouched.
 */
export function enginesMapDerivesStackedPipeline(config) {
  if (!config.enginesExplicit) return false;
  const plan = deriveDefaultPlan(config.engines ?? {}, config.enabled !== false);
  return plan.mode === "stacked" && plan.stackedPipeline.length > 0;
}

/**
 * True when the config has an active named-combo selection that exists in the supplied combos
 * map. chatCore uses this to keep the legacy default-combo fallback from shadowing the
 * operator's active profile.
 */
export function activeComboResolves(config, combos = {}) {
  return Boolean(config.activeComboId && combos[config.activeComboId]);
}
export function getEffectiveMode(config, comboId, estimatedTokens, combos = {}, header = null) {
  return resolveBasePlan(config, comboId, estimatedTokens, combos, header).mode;
}

/**
 * Like {@link selectCompressionStrategy} but returns the full derived plan
 * (effective `mode` + `stackedPipeline`). When the resolver derives a `stacked`
 * plan from the per-engine toggle map, the pipeline is exposed here so the caller
 * can feed it to {@link applyCompressionAsync} (which reads config.stackedPipeline).
 * The caching-aware mode adjustment is applied to `mode` exactly as in
 * {@link selectCompressionStrategy}.
 */
/** Adaptive (Sub-project C) inputs + telemetry sink for selectCompressionPlan. */

export function selectCompressionPlan(config, comboId, estimatedTokens, body, context, combos = {}, header = null, adaptiveOptions) {
  let plan = resolveBasePlan(config, comboId, estimatedTokens, combos, header);

  // Adaptive context-budget floor/escalation (D-C4): after the base plan, replacing the
  // (now-bypassed) auto-trigger branch. Pure resolver; chatCore supplies the model limit.
  if (adaptiveEnabled(config) && config.contextBudget) {
    const {
      plan: adaptivePlan,
      telemetry
    } = resolveAdaptivePlan({
      basePlan: plan,
      estimatedTokens,
      modelContextLimit: adaptiveOptions?.modelContextLimit ?? null,
      requestMaxTokens: adaptiveOptions?.requestMaxTokens ?? null,
      config: config.contextBudget
    });
    plan = adaptivePlan;
    if (telemetry && adaptiveOptions?.onAdaptive) adaptiveOptions.onAdaptive(telemetry);
  }

  // Apply caching-aware adjustments to the mode if body is provided
  if (body) {
    const ctx = detectCachingContext(body, context);
    const cacheAware = getCacheAwareStrategy(plan.mode, ctx);
    return {
      ...plan,
      mode: cacheAware.strategy
    }; // ...plan preserves source
  }
  return plan;
}
export function selectCompressionStrategy(config, comboId, estimatedTokens, body, context, combos = {}, header = null) {
  return selectCompressionPlan(config, comboId, estimatedTokens, body, context, combos, header).mode;
}
export function applyCompression(body, mode, options) {
  return withCompressionEntrypointGuards(body, options, b => runCompression(b, mode, options));
}
function runCompression(body, mode, options) {
  if (mode === "off") {
    return {
      body,
      compressed: false,
      stats: null
    };
  }
  if (options?.config?.memoizeCompressionResults === true &&
  // Only memoize for an explicit principal — a missing principalId would collapse
  // authenticated callers into the shared anonymous (null) key space and let one
  // principal receive another's cached body. No principal ⇒ skip the cache.
  typeof options?.principalId === "string" && options.principalId.length > 0 && isDeterministicMode(mode, options.config)) {
    const key = makeMemoKey(body, mode, options.config, options.principalId, options.model, options.supportsVision);
    const hit = memoLookup(key);
    if (hit) return hit;
    const result = runCompression({
      ...body
    }, mode, {
      ...options,
      config: {
        ...options.config,
        memoizeCompressionResults: false
      }
    });
    memoStore(key, result);
    return memoLookup(key);
  }
  if (mode === "rtk") {
    return applyRtkCompression(body, {
      // Selecting the "rtk" mode IS the enable signal — run it even if the per-engine
      // rtkConfig.enabled flag is off (that flag gates stacked steps). (B-MODE-ENGINE-DECOUPLE)
      config: {
        ...(options?.config?.rtkConfig ?? {}),
        enabled: true
      }
    });
  }
  const adapter = adaptBodyForCompression(body);
  const compressionBody = adapter.body;
  if (mode === "lite") {
    const result = applyLiteCompression(compressionBody, {
      ...options,
      preserveSystemPrompt: options?.config?.preserveSystemPrompt !== false
    });
    return adapter.adapted ? {
      ...result,
      body: adapter.restore(result.body)
    } : result;
  }
  if (mode === "stacked") {
    const result = applyStackedCompression(compressionBody, options?.config?.stackedPipeline, options);
    return adapter.adapted ? {
      ...result,
      body: adapter.restore(result.body)
    } : result;
  }
  if (mode === "standard") {
    const cavemanConfig = {
      ...(options?.config?.cavemanConfig ?? {}),
      ...(options?.config?.languageConfig?.enabled ? {
        language: options.config.languageConfig.defaultLanguage,
        autoDetectLanguage: options.config.languageConfig.autoDetect,
        enabledLanguagePacks: options.config.languageConfig.enabledPacks
      } : {}),
      ...(options?.config?.preserveSystemPrompt !== false ? {
        compressRoles: (options?.config?.cavemanConfig?.compressRoles ?? ["user"]).filter(role => role !== "system")
      } : {}),
      // Selecting the "standard" mode runs caveman regardless of the per-engine
      // cavemanConfig.enabled flag (that flag gates stacked steps). (B-MODE-ENGINE-DECOUPLE)
      enabled: true
    };
    const result = cavemanCompress(compressionBody, cavemanConfig);
    return adapter.adapted ? {
      ...result,
      body: adapter.restore(result.body)
    } : result;
  }
  if (mode === "aggressive") {
    const messages = compressionBody.messages ?? [];
    if (!Array.isArray(messages) || messages.length === 0) {
      return {
        body,
        compressed: false,
        stats: null
      };
    }
    const aggressiveConfig = {
      ...(options?.config?.aggressive ?? {}),
      preserveSystemPrompt: options?.config?.preserveSystemPrompt !== false
    };
    const result = compressAggressive(messages, aggressiveConfig);
    const compressedBody = {
      ...compressionBody,
      messages: result.messages
    };
    return {
      body: adapter.restore(compressedBody),
      compressed: result.stats.savingsPercent > 0,
      stats: createCompressionStats(compressionBody, compressedBody, mode, ["aggressive"], result.stats.rulesApplied, result.stats.durationMs)
    };
  }
  if (mode === "ultra") {
    const messages = compressionBody.messages ?? [];
    if (!Array.isArray(messages) || messages.length === 0) {
      return {
        body,
        compressed: false,
        stats: null
      };
    }
    const ultraConfig = {
      ...(options?.config?.ultra ?? {}),
      preserveSystemPrompt: options?.config?.preserveSystemPrompt !== false
    };
    const result = ultraCompressHeuristic(messages, ultraConfig);
    const compressedBody = {
      ...compressionBody,
      messages: result.messages
    };
    return {
      body: adapter.restore(compressedBody),
      compressed: result.stats.savingsPercent > 0,
      stats: {
        ...createCompressionStats(compressionBody, compressedBody, mode, ["ultra"], result.stats.rulesApplied, result.stats.durationMs),
        ultraTier: result.stats.ultraTier
      }
    };
  }
  return {
    body,
    compressed: false,
    stats: null
  };
}

/**
 * Async entry point mirroring {@link applyCompression}. Only the stacked mode
 * can host async engines, so it routes through {@link applyStackedCompressionAsync};
 * every other mode delegates to the synchronous path unchanged. Call sites that
 * already run in an async context (e.g. chatCore) await this so a future
 * worker-thread engine can await without changing the surrounding code.
 */
export async function applyCompressionAsync(body, mode, options) {
  return withCompressionEntrypointGuardsAsync(body, options, b => runCompressionAsync(b, mode, options));
}
async function runCompressionAsync(body, mode, options) {
  if (options?.config?.memoizeCompressionResults === true &&
  // Only memoize for an explicit principal — a missing principalId would collapse
  // authenticated callers into the shared anonymous (null) key space and let one
  // principal receive another's cached body. No principal ⇒ skip the cache.
  typeof options?.principalId === "string" && options.principalId.length > 0 && isDeterministicMode(mode, options.config)) {
    const key = makeMemoKey(body, mode, options.config, options.principalId, options.model, options.supportsVision);
    const hit = memoLookup(key);
    if (hit) return hit;
    const result = await runCompressionAsync({
      ...body
    }, mode, {
      ...options,
      config: {
        ...options.config,
        memoizeCompressionResults: false
      }
    });
    memoStore(key, result);
    return memoLookup(key);
  }
  if (mode === "stacked") {
    const adapter = adaptBodyForCompression(body);
    const result = await applyStackedCompressionAsync(adapter.body, options?.config?.stackedPipeline, options);
    return adapter.adapted ? {
      ...result,
      body: adapter.restore(result.body)
    } : result;
  }
  // Ultra's optional SLM (model) tier is async — route it here when a model is configured.
  if (mode === "ultra") {
    return applyUltraAsync(body, options);
  }
  return applyCompression(body, mode, options);
}

/**
 * Ultra mode with the optional local SLM (model) tier.
 *
 * When `config.ultra.modelPath` is set, the prose is routed through the llmlingua engine
 * (the real local-model compressor). The llmlingua backend fail-opens when the model is
 * absent (e.g. the ONNX model is not provisioned), so this degrades gracefully:
 *  - model present and it compresses  → return the SLM result (tagged "ultra-slm");
 *  - model absent / no gain / failure → fall back to `aggressive` when
 *    `slmFallbackToAggressive` is set, otherwise the heuristic ultra (`pruneByScore`).
 *
 * Without `modelPath` the behavior is byte-identical to the synchronous heuristic ultra.
 */
async function applyUltraAsync(body, options) {
  const ultraConfig = options?.config?.ultra;
  const modelPath = typeof ultraConfig?.modelPath === "string" ? ultraConfig.modelPath.trim() : "";

  // No explicit modelPath → run the two-tier ultra resolver (heuristic, or SLM when
  // config.ultraEngine === "slm" and the worker backend is available). This is the
  // Phase-4 (B) path; it fail-opens to the heuristic and records the resolved tier.
  if (!modelPath) {
    const adapter = adaptBodyForCompression(body);
    const messages = adapter.body.messages ?? [];
    if (!Array.isArray(messages) || messages.length === 0) {
      return {
        body,
        compressed: false,
        stats: null
      };
    }
    const ultraConfig = {
      ...(options?.config?.ultra ?? {}),
      preserveSystemPrompt: options?.config?.preserveSystemPrompt !== false,
      ultraEngine: options?.config?.ultraEngine
    };
    const result = await ultraCompress(messages, ultraConfig);
    const compressedBody = {
      ...adapter.body,
      messages: result.messages
    };
    return {
      body: adapter.restore(compressedBody),
      compressed: result.stats.savingsPercent > 0,
      stats: {
        ...createCompressionStats(adapter.body, compressedBody, "ultra", result.stats.techniquesUsed, result.stats.rulesApplied, result.stats.durationMs),
        ultraTier: result.stats.ultraTier
      }
    };
  }
  registerBuiltinCompressionEngines();
  const slmEngine = getCompressionEngine("llmlingua");
  if (slmEngine?.applyAsync) {
    const engineOptions = {
      model: options?.model,
      supportsVision: options?.supportsVision,
      config: options?.config,
      principalId: options?.principalId,
      stepConfig: {
        modelPath,
        ...(typeof ultraConfig?.compressionRate === "number" ? {
          compressionRate: ultraConfig.compressionRate
        } : {})
      }
    };
    try {
      const slm = await slmEngine.applyAsync(body, engineOptions);
      if (slm.compressed && slm.stats) {
        // Attribute the result to ultra (the selected mode) while marking the SLM tier.
        return {
          ...slm,
          stats: {
            ...slm.stats,
            mode: "ultra",
            techniquesUsed: Array.from(new Set([...(slm.stats.techniquesUsed ?? []), "ultra-slm"]))
          }
        };
      }
    } catch {
      // llmlingua fail-opens internally, but guard anyway and use the configured fallback.
    }
  }

  // SLM tier unavailable or produced no gain → fall back per slmFallbackToAggressive.
  return applyCompression(body, ultraConfig?.slmFallbackToAggressive ? "aggressive" : "ultra", options);
}
function normalizePipelineStep(step) {
  if (typeof step !== "string") return step;
  if (step === "standard") return {
    engine: "caveman"
  };
  if (step === "rtk") return {
    engine: "rtk"
  };
  if (step === "lite" || step === "aggressive" || step === "ultra") return {
    engine: step
  };
  return {
    engine: "caveman"
  };
}

/** Per-engine progress emitted mid-pipeline by the stacked loops (F3.3 live streaming). */

/** Emit a per-engine step to the live streaming callback (best-effort, no-op when unset). */
function reportEngineStep(onStep, stepIndex, totalSteps, engine, result) {
  if (!onStep) return;
  const s = result.stats;
  onStep({
    stepIndex,
    totalSteps,
    engine,
    state: result.compressed ? "done" : "skipped",
    originalTokens: s?.originalTokens ?? 0,
    compressedTokens: s?.compressedTokens ?? s?.originalTokens ?? 0,
    savingsPercent: s?.savingsPercent ?? 0,
    ...(s?.durationMs !== undefined ? {
      durationMs: s.durationMs
    } : {})
  });
}
function resolveStackSteps(pipeline) {
  return pipeline && pipeline.length > 0 ? pipeline.map(normalizePipelineStep) : [{
    engine: "rtk",
    intensity: "standard"
  }, {
    engine: "caveman",
    intensity: "full"
  }];
}
function buildStepOptions(step, options) {
  return {
    ...options,
    compressionComboId: options?.compressionComboId ?? options?.config?.compressionComboId,
    principalId: options?.principalId,
    stepConfig: {
      ...(step.config ?? {}),
      ...(step.intensity ? {
        intensity: step.intensity
      } : {})
    }
  };
}
function finalizeStackedResult(originalBody, currentBody, compressed, acc, start, compressionComboId) {
  const stats = createCompressionStats(originalBody, currentBody, "stacked", Array.from(acc.techniques), acc.rules.size > 0 ? Array.from(acc.rules) : undefined, Math.round((performance.now() - start) * 100) / 100);
  stats.engine = "stacked";
  stats.compressionComboId = compressionComboId ?? null;
  stats.engineBreakdown = acc.breakdown;
  if (acc.validationWarnings.size > 0) {
    stats.validationWarnings = Array.from(acc.validationWarnings);
  }
  if (acc.validationErrors.size > 0) {
    stats.validationErrors = Array.from(acc.validationErrors);
  }
  if (acc.fallbackApplied) {
    stats.fallbackApplied = true;
  }
  if (acc.rtkRawOutputPointers.length > 0) {
    const seenPointers = new Set();
    stats.rtkRawOutputPointers = acc.rtkRawOutputPointers.filter(pointer => {
      if (seenPointers.has(pointer.id)) return false;
      seenPointers.add(pointer.id);
      return true;
    });
  }

  // T02 / H1: honest aggregate inflation guard. If the fully-stacked body did not actually shrink
  // (its token count is >= the original), discard it and return the verbatim original — safe by
  // construction, since the original request body is always a valid payload.
  const inflation = guardPipelineInflation({
    originalBody,
    compressedBody: currentBody,
    originalTokens: stats.originalTokens,
    compressedTokens: stats.compressedTokens
  });
  if (inflation.inflated) {
    const inflatedTokens = stats.compressedTokens;
    const warnings = new Set(stats.validationWarnings ?? []);
    warnings.add(`pipeline-inflation-guard: stacked output (${inflatedTokens} tok) did not shrink input ` + `(${stats.originalTokens} tok); reverted to original`);
    stats.validationWarnings = Array.from(warnings);
    stats.fallbackApplied = true;
    stats.compressedTokens = stats.originalTokens;
    stats.savingsPercent = 0;
    return {
      body: inflation.body,
      compressed: false,
      stats
    };
  }
  return {
    body: currentBody,
    compressed,
    stats
  };
}

// ── Shared per-step helpers (used by the sync + async stacked loops; keep them in lockstep) ──

/** Failure path: record the breaker failure (when on) + keep the verbatim body, surfacing it in telemetry. */
function recordStepFailure(acc, engineId, err, ctx) {
  if (ctx.breakerOn) recordEngineFailure(engineId, ctx.breaker);
  acc.validationErrors.add(`${engineId}: bailed out — ${err instanceof Error ? err.message : String(err)}`);
  acc.fallbackApplied = true;
}

/**
 * Success path: record the breaker success (when on), merge telemetry, and decide whether to
 * advance `currentBody`. Advance rule: TV1 bail-out uses min-gain (`decideStep`); otherwise the
 * legacy `result.compressed`. Returns the (possibly unchanged) body + whether it advanced.
 */
function commitStepResult(acc, step, result, currentBody, ctx) {
  if (ctx.breakerOn) recordEngineSuccess(step.engine, ctx.breaker);
  mergeStackStep(acc, step.engine, result);
  const advance = ctx.bailout?.enabled ? decideStep(result, ctx.bailout).advance : result.compressed;
  if (advance && gateAdvance(result, currentBody, ctx.fidelityGate, acc, step.engine)) {
    return {
      body: result.body,
      advanced: true
    };
  }
  return {
    body: currentBody,
    advanced: false
  };
}
export function applyStackedCompression(body, pipeline, options) {
  return withRiskGate(body, resolveRiskGate(options), b => runStackedCompression(b, pipeline, options));
}
function runStackedCompression(body, pipeline, options) {
  const steps = resolveStackSteps(pipeline);
  registerBuiltinCompressionEngines();
  let currentBody = body;
  let compressed = false;
  const acc = createStackAccumulator();
  const start = performance.now();
  const bailout = options?.bailout;
  const breaker = resolvePipelineBreakerConfig(options?.circuitBreaker ?? options?.config?.pipelineCircuitBreaker);
  const breakerOn = breaker.enabled;
  const fidelityGate = options?.fidelityGate ?? options?.config?.fidelityGate;
  const onStep = options?.onEngineStep;
  const totalSteps = steps.length;
  let stepIdx = 0;
  for (const step of steps) {
    const engine = getCompressionEngine(step.engine);
    if (!engine) continue;
    // Respect the registry enabled flag: a step naming a disabled engine is skipped, so an
    // operator can turn an engine off (setEngineEnabled) without editing every pipeline.
    if (getEngineEntry(step.engine)?.enabled === false) continue;
    // T02: when the per-engine breaker is OPEN, skip this step (verbatim body kept — fail-open).
    if (breakerOn && !canRunEngine(step.engine, breaker)) {
      acc.validationWarnings.add(`${step.engine}: skipped (pipeline circuit-breaker open)`);
      continue;
    }

    // TV1 bail-out (per-request) OR T02 breaker (cross-request) wrap the call so a throwing engine
    // is caught + recorded; when neither is on, a throw propagates (byte-identical to legacy).
    const ctx = {
      bailout,
      breakerOn,
      breaker,
      fidelityGate
    };
    let result;
    if (bailout?.enabled || breakerOn) {
      try {
        result = engine.apply(currentBody, buildStepOptions(step, options));
      } catch (err) {
        recordStepFailure(acc, step.engine, err, ctx);
        continue;
      }
    } else {
      result = engine.apply(currentBody, buildStepOptions(step, options));
    }
    const committed = commitStepResult(acc, step, result, currentBody, ctx);
    currentBody = committed.body;
    if (committed.advanced) compressed = true;
    // The pre-existing bail-out path did not stream per-step; everything else does.
    if (!bailout?.enabled) reportEngineStep(onStep, stepIdx++, totalSteps, step.engine, result);
  }

  // Hard-budget post-pass (#17): runs after all engines, before finalize.
  if (options?.config?.targetTokens != null || options?.config?.targetRatio != null) {
    const hbResult = applyHardBudget(currentBody, {
      targetTokens: options.config.targetTokens,
      targetRatio: options.config.targetRatio
    });
    if (hbResult.compressed) {
      mergeStackStep(acc, "hard-budget", hbResult);
      currentBody = hbResult.body;
      compressed = true;
    } else {
      // No unit could be dropped (e.g. every unit is preserve-guarded): surface the
      // unreachable-budget validationWarnings instead of dropping them silently (#17 fix #3).
      // mergeStackStep is gated on `compressed`, so propagate the warnings here directly.
      hbResult.stats?.validationWarnings?.forEach(w => acc.validationWarnings.add(w));
    }
  }
  return finalizeStackedResult(body, currentBody, compressed, acc, start, options?.compressionComboId ?? options?.config?.compressionComboId);
}

/**
 * Async sibling of {@link applyStackedCompression} (H10). Awaits engines that
 * expose `applyAsync` (e.g. worker-thread models) and runs synchronous engines
 * inline. Behaviour is otherwise identical: same step order, same accumulated
 * telemetry, same final stats — so sync-only pipelines yield the same result.
 */
export async function applyStackedCompressionAsync(body, pipeline, options) {
  return withRiskGateAsync(body, resolveRiskGate(options), b => runStackedCompressionAsync(b, pipeline, options));
}
async function runStackedCompressionAsync(body, pipeline, options) {
  const steps = resolveStackSteps(pipeline);
  registerBuiltinCompressionEngines();
  let currentBody = body;
  let compressed = false;
  const acc = createStackAccumulator();
  const start = performance.now();
  const bailout = options?.bailout;
  const breaker = resolvePipelineBreakerConfig(options?.circuitBreaker ?? options?.config?.pipelineCircuitBreaker);
  const breakerOn = breaker.enabled;
  const fidelityGate = options?.fidelityGate ?? options?.config?.fidelityGate;
  const onStep = options?.onEngineStep;
  const totalSteps = steps.length;
  let stepIdx = 0;
  for (const step of steps) {
    const engine = getCompressionEngine(step.engine);
    if (!engine) continue;
    // Respect the registry enabled flag (same as the sync loop) — keep both in lockstep.
    if (getEngineEntry(step.engine)?.enabled === false) continue;
    // T02: skip an engine whose breaker is OPEN (verbatim body kept — fail-open). Lockstep w/ sync.
    if (breakerOn && !canRunEngine(step.engine, breaker)) {
      acc.validationWarnings.add(`${step.engine}: skipped (pipeline circuit-breaker open)`);
      continue;
    }
    const stepOptions = buildStepOptions(step, options);

    // TV1 bail-out (per-request) OR T02 breaker (cross-request) wrap the call (lockstep w/ sync).
    const ctx = {
      bailout,
      breakerOn,
      breaker,
      fidelityGate
    };
    let result;
    if (bailout?.enabled || breakerOn) {
      try {
        result = engine.applyAsync ? await engine.applyAsync(currentBody, stepOptions) : engine.apply(currentBody, stepOptions);
      } catch (err) {
        recordStepFailure(acc, step.engine, err, ctx);
        continue;
      }
    } else {
      result = engine.applyAsync ? await engine.applyAsync(currentBody, stepOptions) : engine.apply(currentBody, stepOptions);
    }
    const committed = commitStepResult(acc, step, result, currentBody, ctx);
    currentBody = committed.body;
    if (committed.advanced) compressed = true;
    if (!bailout?.enabled) reportEngineStep(onStep, stepIdx++, totalSteps, step.engine, result);
  }

  // Hard-budget post-pass (#17): runs after all engines, before finalize.
  if (options?.config?.targetTokens != null || options?.config?.targetRatio != null) {
    const hbResult = applyHardBudget(currentBody, {
      targetTokens: options.config.targetTokens,
      targetRatio: options.config.targetRatio
    });
    if (hbResult.compressed) {
      mergeStackStep(acc, "hard-budget", hbResult);
      currentBody = hbResult.body;
      compressed = true;
    } else {
      // No unit could be dropped (e.g. every unit is preserve-guarded): surface the
      // unreachable-budget validationWarnings instead of dropping them silently (#17 fix #3).
      // mergeStackStep is gated on `compressed`, so propagate the warnings here directly.
      hbResult.stats?.validationWarnings?.forEach(w => acc.validationWarnings.add(w));
    }
  }
  return finalizeStackedResult(body, currentBody, compressed, acc, start, options?.compressionComboId ?? options?.config?.compressionComboId);
}