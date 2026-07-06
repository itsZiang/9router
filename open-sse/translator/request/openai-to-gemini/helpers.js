// Pure, self-contained helpers extracted verbatim from ../openai-to-gemini.ts
// (god-file decomposition): historical-tool-context string builders, undefined-
// pruning, thought-signature extraction, tool-name remapping, and the Vertex
// provider check + Antigravity generation-config defaults. No I/O or module state;
// the host imports them back internally (these were module-private — no public API
// change). The GeminiGenerationConfig shape lives here with its only mutator.

// Vertex AI (and Vertex Partner models) reject the OpenAI-style `id` field inside
// function_call / function_response parts. Detect these by the routed provider id.
export function isVertexGeminiProvider(provider) {
  return provider === "vertex" || provider === "vertex-partner";
}
export function buildChangedToolNameMap(toolNameMap) {
  const changedEntries = [...toolNameMap.entries()].filter(([sanitizedName, originalName]) => sanitizedName !== originalName);
  return changedEntries.length > 0 ? new Map(changedEntries) : null;
}
export function extractClientThoughtSignature(toolCall) {
  if (!toolCall || typeof toolCall !== "object") return null;
  const candidate = toolCall;
  const signature = candidate.thoughtSignature || candidate.thought_signature || candidate.function?.thoughtSignature || candidate.function?.thought_signature || null;
  return typeof signature === "string" && signature.length > 0 ? signature : null;
}
export function deepCleanUndefined(value, depth = 0) {
  if (depth > 10 || !value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      deepCleanUndefined(item, depth + 1);
    }
  } else {
    const obj = value;
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (typeof val === "string" && val === "[undefined]") {
        delete obj[key];
      } else {
        deepCleanUndefined(val, depth + 1);
      }
    }
  }
}
export function applyAntigravityGenerationDefaults(generationConfig) {
  const config = {
    ...generationConfig
  };
  if (config.topK === undefined) {
    config.topK = 40;
  }
  if (config.topP === undefined) {
    config.topP = 1;
  }
  const thinkingBudget = Number(config.thinkingConfig?.thinkingBudget);
  const maxOutputTokens = Number(config.maxOutputTokens);
  if (Number.isFinite(thinkingBudget) && thinkingBudget > 0 && (!Number.isFinite(maxOutputTokens) || maxOutputTokens <= thinkingBudget)) {
    config.maxOutputTokens = Math.floor(thinkingBudget) + 1;
  }
  return config;
}
export function stringifyHistoricalToolArguments(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return String(value ?? "{}");
  }
}
export function buildInertHistoricalToolCallText(name, args) {
  const toolName = name || "unknown";
  return `[tool_history_call: ${toolName}] ${stringifyHistoricalToolArguments(args || "{}")}`;
}
export function buildInertHistoricalToolResponseText(name, response) {
  return `[tool_history_result: ${name || "unknown"}] ${typeof response === "string" ? response : stringifyHistoricalToolArguments(response)}`;
}
export function escapeHistoricalContextAttribute(value) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
export function escapeHistoricalContextContent(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
export function buildHistoricalToolResultContext(name, response) {
  const source = escapeHistoricalContextAttribute(name || "unknown");
  const rawResult = typeof response === "string" ? response : stringifyHistoricalToolArguments(response);
  const result = escapeHistoricalContextContent(rawResult);
  return [`<previous_tool_result_context source="${source}">`, result, "</previous_tool_result_context>"].join("\n");
}