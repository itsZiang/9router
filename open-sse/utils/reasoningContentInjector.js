/**
 * Thinking-mode upstreams (DeepSeek V4 Flash, Kimi, MiniMax, ...) require
 * `reasoning_content` to be echoed back on every assistant message in the
 * conversation history. Standard OpenAI clients do not preserve that field
 * across turns, so we inject a non-empty placeholder before forwarding.
 *
 * Without the placeholder these upstreams return:
 *   400 Bad Request — reasoning_content must be passed back
 *
 * Ported from decolua/9router#1099 (issue #1543). Pure helper — no I/O, no
 * cross-module deps — kept narrow so it can be reused by other meta-providers
 * that proxy to thinking-mode models.
 */

const PLACEHOLDER = " ";
/**
 * Model-id predicates for thinking-mode families that need the echo.
 * Matched case-insensitively against the resolved model id (post upstream
 * routing, e.g. `oc/deepseek-v4-flash-free` for the OpenCode meta-provider).
 */
const THINKING_MODEL_PATTERNS = [/deepseek/i, /\bkimi\b/i, /\bk2\b/i,
// moonshot kimi k2 family alias
/\bminimax\b/i];
export function isThinkingMessageModel(model) {
  if (!model || typeof model !== "string") return false;
  return THINKING_MODEL_PATTERNS.some(re => re.test(model));
}
function hasNonEmptyReasoningContent(message) {
  return typeof message.reasoning_content === "string" && message.reasoning_content.trim().length > 0;
}
function isAssistantMessage(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) && value.role === "assistant";
}

/**
 * Inject a placeholder `reasoning_content` on every assistant message in
 * `body.messages` that lacks one. Returns the original object if no mutation
 * was needed, or a shallow-copied body with a new messages array otherwise.
 *
 * No-op when the body shape is unexpected (defensive).
 */
export function injectReasoningContentForThinkingModel(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const record = body;
  if (!Array.isArray(record.messages)) return body;
  let modified = false;
  const messages = record.messages.map(message => {
    if (!isAssistantMessage(message)) return message;
    if (hasNonEmptyReasoningContent(message)) return message;
    modified = true;
    return {
      ...message,
      reasoning_content: PLACEHOLDER
    };
  });
  return modified ? {
    ...record,
    messages
  } : body;
}