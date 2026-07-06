/**
 * chatCore Background Task Redirection decision (T41) (Quality Gate v2 / Fase 9 — chatCore god-file
 * decomposition, #3501).
 *
 * Decides whether a request should be downgraded to a cheaper "degraded" model: only when the
 * feature is enabled, the request looks like a background/utility task, AND the model has a
 * degradation mapping. Returns the target model + the detection reason, or null for no redirect.
 * The handler keeps the side effects byte-identically (the BACKGROUND log, the model + body.model
 * mutation, and the audit event). Reads the live backgroundTaskDetector config, mirroring the
 * previous inline block.
 */

import { getBackgroundDegradationConfig, getBackgroundTaskReason, getDegradedModel } from "../../services/backgroundTaskDetector";
export function resolveBackgroundTaskRedirect(opts) {
  const bgConfig = getBackgroundDegradationConfig();
  const backgroundReason = bgConfig.enabled ? getBackgroundTaskReason(opts.body, opts.headers ?? null) : null;
  if (!backgroundReason) return {
    backgroundReason: null,
    redirect: null
  };
  const degradedModel = getDegradedModel(opts.model);
  if (degradedModel === opts.model) return {
    backgroundReason,
    redirect: null
  };
  return {
    backgroundReason,
    redirect: {
      degradedModel,
      reason: backgroundReason
    }
  };
}