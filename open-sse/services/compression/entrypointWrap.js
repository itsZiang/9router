import { resolveRiskGate, withRiskGate } from "./riskGate/strategyWrap";
import { resolveQuantumLock, quantumCachingContext, withQuantumLock, withQuantumLockAsync } from "./quantumLock/index";
export function withCompressionEntrypointGuards(body, options, run) {
  return withQuantumLock(body, resolveQuantumLock(options), quantumCachingContext(body, options), quantumBody => withRiskGate(quantumBody, resolveRiskGate(options), riskBody => run(riskBody)));
}
export function withCompressionEntrypointGuardsAsync(body, options, run) {
  return withQuantumLockAsync(body, resolveQuantumLock(options), quantumCachingContext(body, options), run);
}