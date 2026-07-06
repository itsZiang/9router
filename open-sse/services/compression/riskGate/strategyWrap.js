import { applyRiskMask, restoreRiskBlocks } from "./riskGateStep";
/** Resolve the effective risk-gate config (explicit option wins over config); enabled-gated. */
export function resolveRiskGate(options) {
  const rg = options?.riskGate ?? options?.config?.riskGate;
  return rg?.enabled ? rg : undefined;
}
function attach(result, mask) {
  if (mask.blocks.length) result.body = restoreRiskBlocks(result.body, mask.blocks);
  if (result.stats) result.stats.riskGate = mask.stats;
  return result;
}

/** Outer mask→run→restore wrapper for a sync compression entry point. Byte-identical when gate absent. */
export function withRiskGate(body, riskGate, run) {
  if (!riskGate) return run(body);
  const mask = applyRiskMask(body, riskGate);
  return attach(run(mask.maskedBody), mask);
}

/** Async variant of withRiskGate. */
export async function withRiskGateAsync(body, riskGate, run) {
  if (!riskGate) return run(body);
  const mask = applyRiskMask(body, riskGate);
  return attach(await run(mask.maskedBody), mask);
}