import { DefaultExecutor } from "./default";
import { applyProviderRequestDefaults } from "../services/providerRequestDefaults";
import { NON_ANTHROPIC_THINKING_PLACEHOLDER } from "../translator/helpers/claudeHelper";
function hasActiveKimiThinking(body) {
  const thinking = body.thinking;
  if (thinking && typeof thinking === "object" && !Array.isArray(thinking)) {
    const thinkingRecord = thinking;
    return thinkingRecord.type === "enabled" || thinkingRecord.type === "adaptive";
  }
  return false;
}
function hasNonEmptyReasoningContent(message) {
  return typeof message.reasoning_content === "string" && message.reasoning_content.trim().length > 0;
}
function isToolUseBlock(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) && value.type === "tool_use";
}
function isThinkingBlock(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) && (value.type === "thinking" || value.type === "redacted_thinking");
}
function hasAssistantToolCalls(message) {
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return true;
  return Array.isArray(message.content) && message.content.some(isToolUseBlock);
}
function isClaudeProtocolBody(body) {
  if (Array.isArray(body.system)) return true;
  if (!Array.isArray(body.messages)) return false;
  return body.messages.some(message => {
    const msg = asRecord(message);
    if (!msg || !Array.isArray(msg.content)) return false;
    return msg.content.some(part => {
      const block = asRecord(part);
      return block?.type === "text" || block?.type === "tool_use" || block?.type === "tool_result";
    });
  });
}
function disableKimiPreservedThinking(body) {
  if (!isClaudeProtocolBody(body)) return body;
  const thinking = asRecord(body.thinking) ?? {
    type: "enabled"
  };
  if (thinking.keep === null) return body;
  return {
    ...body,
    thinking: {
      ...thinking,
      keep: null
    }
  };
}
function ensureKimiThinkingContent(message) {
  const reasoningContent = hasNonEmptyReasoningContent(message) ? String(message.reasoning_content) : NON_ANTHROPIC_THINKING_PLACEHOLDER;
  let nextMessage = hasNonEmptyReasoningContent(message) ? message : {
    ...message,
    reasoning_content: reasoningContent
  };
  if (!Array.isArray(nextMessage.content)) return nextMessage;
  const firstToolUseIndex = nextMessage.content.findIndex(isToolUseBlock);
  if (firstToolUseIndex < 0 || nextMessage.content.some(isThinkingBlock)) return nextMessage;
  const content = [...nextMessage.content];
  content.splice(firstToolUseIndex, 0, {
    type: "thinking",
    thinking: reasoningContent
  });
  return {
    ...nextMessage,
    content
  };
}
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function applyKimiRequestDefaults(body, defaults) {
  const withDefaults = applyProviderRequestDefaults(body, defaults);
  const record = asRecord(withDefaults);
  if (!record || !Array.isArray(record.messages)) {
    return withDefaults;
  }
  const kimiBody = disableKimiPreservedThinking(record);
  if (!hasActiveKimiThinking(kimiBody)) return kimiBody;
  let modified = false;
  const sourceMessages = Array.isArray(kimiBody.messages) ? kimiBody.messages : record.messages;
  const messages = sourceMessages.map(message => {
    const msg = asRecord(message);
    if (!msg || msg.role !== "assistant" || !hasAssistantToolCalls(msg)) return message;
    const nextMessage = ensureKimiThinkingContent(msg);
    if (nextMessage !== msg) modified = true;
    return nextMessage;
  });
  return modified ? {
    ...kimiBody,
    messages
  } : kimiBody;
}
export class KimiExecutor extends DefaultExecutor {
  constructor(provider = "kimi-coding") {
    super(provider);
  }
  transformRequest(model, body, stream, credentials) {
    const cleanedBody = super.transformRequest(model, body, stream, credentials);
    return applyKimiRequestDefaults(cleanedBody);
  }
}
export default KimiExecutor;