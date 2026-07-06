/**
 * chatCore Claude effort-variant normalizer (Quality Gate v2 / Fase 9 — chatCore god-file
 * decomposition, #3501).
 *
 * The Claude / Claude-Code model picker (e.g. VS Code's "Effort" slider) advertises
 * claude-...-{low,medium,high,xhigh,max}. Anthropic has no such model, so the suffixed id 404s
 * upstream. This strips it back to the real base id and surfaces the level as reasoning_effort so
 * the OpenAI→Claude translator / Claude-Code bridge can turn it into Claude thinking/effort config.
 * An explicit client-supplied effort always wins; native Claude passthrough (sourceFormat === claude)
 * is left untouched (it carries its own `thinking`). The body is mutated in place (model +
 * reasoning_effort), byte-identical to the previous inline block; the new effectiveModel and an
 * optional log line are returned for the handler to apply.
 */

import { splitClaudeEffortSuffix } from "../../config/providerModels";
import { isClaudeCodeCompatibleProvider } from "../../services/claudeCodeCompatible";
import { FORMATS } from "../../translator/formats";

/**
 * True when the client already supplied an explicit reasoning effort (top-level reasoning_effort,
 * reasoning.effort, or output_config.effort) — in which case the stripped suffix must not overwrite
 * it. A blank string counts as "not supplied".
 */
function hasExplicitClaudeEffort(claudeBody) {
  const explicitEffort = claudeBody.reasoning_effort ?? claudeBody.reasoning?.effort ?? claudeBody.output_config?.effort;
  return !(explicitEffort === undefined || explicitEffort === null || explicitEffort === "");
}
export function applyClaudeEffortVariant(opts) {
  const {
    provider,
    body,
    sourceFormat
  } = opts;
  let effectiveModel = opts.effectiveModel;
  let log = null;
  if ((provider === "claude" || isClaudeCodeCompatibleProvider(provider)) && typeof effectiveModel === "string") {
    const {
      baseModel,
      effort
    } = splitClaudeEffortSuffix(effectiveModel);
    if (effort) {
      effectiveModel = baseModel;
      if (body && typeof body === "object" && !Array.isArray(body)) {
        const claudeBody = body;
        claudeBody.model = baseModel;
        if (sourceFormat !== FORMATS.CLAUDE && !hasExplicitClaudeEffort(claudeBody)) {
          claudeBody.reasoning_effort = effort;
        }
      }
      log = `Claude effort variant: stripped "-${effort}" → ${baseModel} (reasoning_effort=${effort})`;
    }
  }
  return {
    effectiveModel,
    log
  };
}