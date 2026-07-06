export function isQwenThinkingActive(body) {
  const thinking = body.thinking;
  if (thinking === true || body.enable_thinking === true) {
    return true;
  }
  return typeof thinking === "object" && thinking !== null && !Array.isArray(thinking) && thinking.type === "enabled";
}
export function isQwenThinkingToolChoiceIncompatible(toolChoice) {
  return toolChoice === "required" || typeof toolChoice === "object" && toolChoice !== null;
}
export function sanitizeQwenThinkingToolChoice(body, providerLabel = "Qwen") {
  if (!isQwenThinkingActive(body)) {
    return body;
  }
  const toolChoice = body.tool_choice;
  if (!isQwenThinkingToolChoiceIncompatible(toolChoice)) {
    return body;
  }
  const toolChoiceLabel = typeof toolChoice === "string" ? toolChoice : "object";
  console.warn(`[${providerLabel}] Neutralizing incompatible tool_choice ${toolChoiceLabel} to "auto" (thinking mode active)`);
  return {
    ...body,
    tool_choice: "auto"
  };
}