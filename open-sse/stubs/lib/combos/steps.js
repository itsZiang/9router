function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function toTrimmed(v) {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}
function toNum(v, fallback = 0) {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim().length > 0 ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
}

export function normalizeComboStep(entry, { comboName, index, allCombos }) {
  if (typeof entry === "string") {
    const trimmed = entry.trim();
    if (!trimmed) return null;
    const slash = trimmed.indexOf("/");
    return {
      kind: "model",
      id: `step-${index}`,
      model: slash > 0 ? trimmed.slice(slash + 1) : trimmed,
      providerId: slash > 0 ? toTrimmed(trimmed.slice(0, slash)) : null,
      weight: 0,
      label: null
    };
  }
  if (isRecord(entry)) {
    if (entry.kind === "combo-ref") {
      const refName = toTrimmed(entry.comboName);
      if (!refName) return null;
      return {
        kind: "combo-ref",
        id: entry.id || `step-${index}`,
        comboName: refName,
        weight: toNum(entry.weight),
        label: toTrimmed(entry.label) || null
      };
    }
    const modelField = toTrimmed(entry.model);
    if (!modelField) return null;
    const slash = modelField.indexOf("/");
    const providerId = toTrimmed(entry.providerId) || (slash > 0 ? toTrimmed(modelField.slice(0, slash)) : null);
    return {
      kind: "model",
      id: entry.id || `step-${index}`,
      model: slash > 0 ? modelField.slice(slash + 1) : modelField,
      providerId,
      weight: toNum(entry.weight),
      label: toTrimmed(entry.label) || null,
      connectionId: toTrimmed(entry.connectionId) || null,
      allowedConnectionIds: Array.isArray(entry.allowedConnectionIds) ? entry.allowedConnectionIds : null
    };
  }
  return null;
}

export function getComboModelString(step) {
  if (typeof step === "string") return step;
  if (!isRecord(step)) return null;
  const model = toTrimmed(step.model);
  if (!model) return null;
  const providerId = toTrimmed(step.providerId);
  return providerId ? `${providerId}/${model}` : model;
}

export function getComboModelProvider(step) {
  if (typeof step === "string") {
    const slash = step.indexOf("/");
    return slash > 0 ? step.slice(0, slash) : null;
  }
  if (!isRecord(step)) return null;
  return toTrimmed(step.providerId) || null;
}

export function getComboStepTarget(entry) {
  if (typeof entry === "string") return entry.trim();
  if (isRecord(entry)) {
    const model = toTrimmed(entry.model);
    if (!model) return null;
    const providerId = toTrimmed(entry.providerId);
    return providerId ? `${providerId}/${model}` : model;
  }
  return null;
}

export function getComboStepWeight(entry) {
  if (typeof entry === "string") return 0;
  if (isRecord(entry)) return toNum(entry.weight);
  return 0;
}

const _defaultExport = {};
export default _defaultExport;