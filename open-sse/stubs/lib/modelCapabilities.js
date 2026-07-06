// Auto-generated stub: stubs/lib/modelCapabilities
// Safe default capabilities: fail-open so combo routing / thinking passthrough
// work correctly for providers not in the full capability registry.
const DEFAULT_STUB_CAPABILITIES = {
  // input modalities
  vision: false,
  pdf: false,
  audioInput: false,
  videoInput: false,
  // output modalities
  imageOutput: false,
  audioOutput: false,
  // features
  search: false,
  tools: true,
  toolCalling: true,       // combo filterTargetsByRequestCompatibility checks this
  supportsTools: true,     // same check, alternate field name
  reasoning: false,
  thinkingFormat: null,
  thinkingCanDisable: true,
  thinkingRange: null,
  // limits — generous defaults; unknown models should not be rejected
  contextWindow: 200000,
  maxInputTokens: null,
  maxOutputTokens: null,
  maxOutput: 64000,
};
export const capMaxOutputTokens = () => undefined,
  capThinkingBudget = () => undefined,
  getDefaultThinkingBudget = () => null,
  getModelContextLimit = () => null,
  // Return a safe capabilities object instead of null so callers like
  // getTargetCompatibilityFailures can safely access .toolCalling / .supportsTools
  // without throwing (which caused "Combo has no executable targets").
  getResolvedModelCapabilities = () => ({ ...DEFAULT_STUB_CAPABILITIES }),
  supportsMaxTokens = () => undefined,
  // Fail-open: return true so applyThinkingBudget does NOT strip reasoning_effort
  // for unrecognized model names (the executor-level sanitizeReasoningEffortForProvider
  // still strips it for providers that explicitly reject it).
  supportsReasoning = () => true,
  supportsToolCalling = () => true;
const _defaultExport = {};
export default _defaultExport;
