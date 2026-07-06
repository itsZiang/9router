export function stringifyIdValue(value) {
  return value === null || value === undefined ? null : String(value);
}
function normalizeResponsesOutputItemIds(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return item;
  }
  const record = item;
  let changed = false;
  const normalized = {
    ...record
  };
  const id = stringifyIdValue(record.id);
  if (id !== null && record.id !== id) {
    normalized.id = id;
    changed = true;
  }
  const callId = stringifyIdValue(record.call_id);
  if (callId !== null && record.call_id !== callId) {
    normalized.call_id = callId;
    changed = true;
  }
  return changed ? normalized : item;
}
export function normalizeResponsesSseIds(payload) {
  let changed = false;
  for (const key of ["response_id", "item_id", "call_id"]) {
    const value = stringifyIdValue(payload[key]);
    if (value !== null && payload[key] !== value) {
      payload[key] = value;
      changed = true;
    }
  }
  if (payload.item && typeof payload.item === "object" && !Array.isArray(payload.item)) {
    const normalizedItem = normalizeResponsesOutputItemIds(payload.item);
    if (normalizedItem !== payload.item) {
      payload.item = normalizedItem;
      changed = true;
    }
  }
  if (payload.response && typeof payload.response === "object" && !Array.isArray(payload.response)) {
    const response = payload.response;
    let responseChanged = false;
    const normalizedResponse = {
      ...response
    };
    const responseId = stringifyIdValue(response.id);
    if (responseId !== null && response.id !== responseId) {
      normalizedResponse.id = responseId;
      responseChanged = true;
    }
    if (Array.isArray(response.output)) {
      const normalizedOutput = response.output.map(normalizeResponsesOutputItemIds);
      if (normalizedOutput.some((item, index) => item !== response.output[index])) {
        normalizedResponse.output = normalizedOutput;
        responseChanged = true;
      }
    }
    if (responseChanged) {
      payload.response = normalizedResponse;
      changed = true;
    }
  }
  return changed;
}
function buildResponsesOutputItemKey(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return null;
  }
  const record = item;
  const type = typeof record.type === "string" ? record.type : "";
  const id = stringifyIdValue(record.id) ?? "";
  const callId = stringifyIdValue(record.call_id) ?? "";
  const outputIndex = typeof record.output_index === "number" ? record.output_index : "";
  const name = typeof record.name === "string" ? record.name : "";
  if (!type && !id && !callId) {
    return null;
  }
  return `${type}:${id}:${callId}:${outputIndex}:${name}`;
}
export function pushUniqueResponsesOutputItems(target, items) {
  const seen = new Set();
  for (const existingItem of target) {
    const key = buildResponsesOutputItemKey(existingItem);
    if (key) {
      seen.add(key);
    }
  }
  for (const item of items) {
    const key = buildResponsesOutputItemKey(item);
    if (key && seen.has(key)) {
      continue;
    }
    target.push(item);
    if (key) {
      seen.add(key);
    }
  }
}
export function backfillResponsesCompletedOutput(parsed, collectedItems) {
  if (!collectedItems.length) return false;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const obj = parsed;
  if (obj.type !== "response.completed") return false;
  const resp = obj.response;
  if (!resp || typeof resp !== "object" || Array.isArray(resp)) return false;
  const r = resp;
  const existing = r.output;
  if (Array.isArray(existing) && existing.length > 0) return false;
  r.output = collectedItems.slice();
  return true;
}
const RESPONSES_LIFECYCLE_EVENT_TYPES = new Set(["response.created", "response.in_progress", "response.completed"]);
export function stripResponsesLifecycleEcho(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const obj = parsed;
  if (typeof obj.type !== "string" || !RESPONSES_LIFECYCLE_EVENT_TYPES.has(obj.type)) {
    return false;
  }
  const resp = obj.response;
  if (!resp || typeof resp !== "object" || Array.isArray(resp)) return false;
  const r = resp;
  let changed = false;
  if ("instructions" in r) {
    delete r.instructions;
    changed = true;
  }
  if ("tools" in r) {
    delete r.tools;
    changed = true;
  }
  return changed;
}