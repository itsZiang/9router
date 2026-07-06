const INTERNAL_ASSISTANT_PHASES = new Set(["commentary"]);
const SERVER_ITEM_ID_PREFIX_BY_TYPE = {
  function_call: "fc_",
  message: "msg_",
  reasoning: "rs_"
};
const SERVER_ITEM_ID_PATTERN = /^(fc|msg|rs|resp)_/;
function toRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function isResponsesMessageItem(record) {
  return record.type === "message" || !record.type && typeof record.role === "string";
}
export function isInternalAssistantMessage(record) {
  if (!isResponsesMessageItem(record)) return false;
  if (record.role !== "assistant") return false;
  const phase = typeof record.phase === "string" ? record.phase.trim().toLowerCase() : "";
  if (!phase) return false;

  // Drop only known internal runtime frames. Visible assistant turns such as
  // `final` and `final_answer` must survive replay for Codex/OpenCode follow-ups.
  return INTERNAL_ASSISTANT_PHASES.has(phase);
}

// OpenAI Responses API enforces two constraints on name fields in input items:
//   1. Max 128 characters
//   2. Must match ^[a-zA-Z0-9_-]+$
// Sanitize after cloning so upstream never sees an invalid name.
function sanitizeFunctionName(name) {
  // Replace any character not in [a-zA-Z0-9_-] with underscore, then truncate.
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
}
function sanitizeInputItemId(record) {
  if (typeof record.id !== "string") return record;
  const type = typeof record.type === "string" ? record.type : "";
  const expectedPrefix = SERVER_ITEM_ID_PREFIX_BY_TYPE[type];
  const hasExpectedPrefix = expectedPrefix ? record.id.startsWith(expectedPrefix) : SERVER_ITEM_ID_PATTERN.test(record.id);
  if (hasExpectedPrefix) return record;
  const next = {
    ...record
  };
  delete next.id;
  return next;
}
function imageUrlToText(value) {
  if (typeof value === "string") return value;
  const record = toRecord(value);
  return typeof record?.url === "string" ? record.url : "";
}
function sanitizeContentPart(part, role) {
  const record = toRecord(part);
  if (!record) return part;
  if (record.type === "image_url") {
    const url = imageUrlToText(record.image_url);
    if (role === "user") {
      const next = {
        type: "input_image",
        image_url: url
      };
      const image = toRecord(record.image_url);
      if (image?.detail !== undefined) next.detail = image.detail;
      return next;
    }
    return {
      type: "output_text",
      text: url ? `[Image: ${url}]` : "[Image]"
    };
  }
  if (role === "assistant" && record.type === "input_image") {
    const url = imageUrlToText(record.image_url);
    return {
      type: "output_text",
      text: url ? `[Image: ${url}]` : "[Image]"
    };
  }
  return part;
}
function sanitizeMessageContent(record) {
  if (!Array.isArray(record.content)) return record;
  const role = typeof record.role === "string" ? record.role.toLowerCase() : "";
  const content = record.content.map(part => sanitizeContentPart(part, role));
  return {
    ...record,
    content
  };
}
function sanitizeOutputContent(record) {
  if (!Array.isArray(record.output)) return record;

  // Some clients replay previous Responses output items inside the next
  // Responses input. In that shape OpenAI validates `input[n].output[m].type`
  // against output content part types, so legacy Chat-style `image_url` parts
  // must be normalized here too, not only in message.content.
  const role = record.type === "function_call_output" ? "user" : "assistant";
  const output = record.output.map(part => sanitizeContentPart(part, role));
  return {
    ...record,
    output
  };
}
function sanitizeInputItem(item) {
  const record = toRecord(item);
  if (!record) return item;
  let next = sanitizeInputItemId(record);
  if (isResponsesMessageItem(next)) {
    next = sanitizeMessageContent(next);
  }
  next = sanitizeOutputContent(next);
  if ((next.type === "function_call" || next.type === "function_call_output") && typeof next.name === "string" && !/^[a-zA-Z0-9_-]{1,128}$/.test(next.name)) {
    next = {
      ...next,
      name: sanitizeFunctionName(next.name)
    };
  }
  return next;
}
export function sanitizeResponsesInputItems(items, clone = true, options = {}) {
  const dropInternalAssistantMessages = options.dropInternalAssistantMessages ?? true;
  const sanitized = [];
  for (const item of items) {
    const record = toRecord(item);
    if (dropInternalAssistantMessages && record && isInternalAssistantMessage(record)) {
      continue;
    }
    const cloned = clone ? structuredClone(item) : item;
    sanitized.push(sanitizeInputItem(cloned));
  }
  return sanitized;
}