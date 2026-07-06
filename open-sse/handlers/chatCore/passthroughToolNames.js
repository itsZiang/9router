import { CLAUDE_OAUTH_TOOL_PREFIX } from "../../translator/request/openai-to-claude";
export function buildClaudePassthroughToolNameMap(body) {
  if (!body || !Array.isArray(body.tools)) return null;
  const toolNameMap = new Map();
  for (const tool of body.tools) {
    const toolRecord = tool;
    const toolData = toolRecord?.type === "function" && toolRecord.function && typeof toolRecord.function === "object" ? toolRecord.function : toolRecord;
    const originalName = typeof toolData?.name === "string" ? toolData.name.trim() : "";
    if (!originalName) continue;
    toolNameMap.set(`${CLAUDE_OAUTH_TOOL_PREFIX}${originalName}`, originalName);
  }
  return toolNameMap.size > 0 ? toolNameMap : null;
}
export function restoreClaudePassthroughToolNames(responseBody, toolNameMap) {
  if (!toolNameMap || !Array.isArray(responseBody?.content)) return responseBody;
  let changed = false;
  const content = responseBody.content.map(block => {
    if (block?.type !== "tool_use" || typeof block?.name !== "string") return block;
    const restoredName = toolNameMap.get(block.name) ?? block.name;
    if (restoredName === block.name) return block;
    changed = true;
    return {
      ...block,
      name: restoredName
    };
  });
  if (!changed) return responseBody;
  return {
    ...responseBody,
    content
  };
}
export function mergeResponseToolNameMap(baseToolNameMap, transformedBody) {
  const executorToolNameMap = transformedBody && transformedBody._toolNameMap instanceof Map ? transformedBody._toolNameMap : null;
  if (!executorToolNameMap?.size) return baseToolNameMap;
  if (!baseToolNameMap?.size) return executorToolNameMap;
  const merged = new Map(baseToolNameMap);
  for (const [toolName, originalName] of executorToolNameMap.entries()) {
    merged.set(toolName, originalName);
  }
  return merged;
}