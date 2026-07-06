/**
 * In-memory request counters for Gemini models — tracks both RPD (daily)
 * and RPM (sliding 60s window) so that 429 responses can be classified
 * as either quota_exhausted (RPD hit) or rate_limit_exceeded (RPM hit).
 *
 * Gemini returns identical error bodies for both types, so we rely on
 * published per-model limits from geminiRateLimits.json to distinguish them.
 *
 * Counters are incremented on every Gemini request so that once usage
 * reaches the published limit, subsequent 429s are correctly classified.
 */

import geminiLimits from "../config/geminiRateLimits.json";

// ── RPD (daily) state ────────────────────────────────────────────────────────

const dailyCounts = new Map();

// ── RPM (sliding 60s window) state ───────────────────────────────────────────

const minuteWindows = new Map();

// ── Helpers ──────────────────────────────────────────────────────────────────

function toDateKey() {
  return new Date().toISOString().slice(0, 10);
}
function stripModelPrefix(modelId) {
  // Only strip the "gemini/" provider prefix, never "gemini-" which is part
  // of the actual model name (e.g. "gemini-2.5-flash", "gemini-3.5-live-translate").
  return modelId.replace(/^gemini\//, "").trim();
}
function lookupValue(modelId, field) {
  if (!modelId) return 0;
  const key = stripModelPrefix(modelId);
  const entry = geminiLimits[key];
  if (!entry) {
    for (const [knownKey, knownEntry] of Object.entries(geminiLimits)) {
      if (key.endsWith(knownKey) || knownKey.endsWith(key)) {
        const val = knownEntry[field];
        return typeof val === "number" && val > 0 ? val : 0;
      }
    }
    return 0;
  }
  const val = entry[field];
  return typeof val === "number" && val > 0 ? val : 0;
}

// ── RPD exports ──────────────────────────────────────────────────────────────

export function getModelRpd(modelId) {
  return lookupValue(modelId, "rpd");
}
export function incrementDailyRequestCount(modelId) {
  if (!modelId) return;
  const key = stripModelPrefix(modelId);
  const today = toDateKey();
  const existing = dailyCounts.get(key);
  if (existing && existing.date === today) {
    existing.count++;
  } else {
    dailyCounts.set(key, {
      date: today,
      count: 1
    });
  }
}
export function getDailyRequestCount(modelId) {
  if (!modelId) return 0;
  const key = stripModelPrefix(modelId);
  const today = toDateKey();
  const entry = dailyCounts.get(key);
  if (entry && entry.date === today) return entry.count;
  return 0;
}
export function isRpdExhausted(modelId) {
  const rpd = getModelRpd(modelId);
  if (rpd <= 0) return false;
  return getDailyRequestCount(modelId) >= rpd;
}

// ── RPM exports ──────────────────────────────────────────────────────────────

export function getModelRpm(modelId) {
  return lookupValue(modelId, "rpm");
}

/** Prune timestamps older than 60 seconds from a model's window. */
function pruneMinuteWindow(key) {
  const now = Date.now();
  const cutoff = now - 60_000;
  const timestamps = minuteWindows.get(key);
  if (!timestamps) return;
  // Keep only timestamps >= cutoff
  let i = 0;
  while (i < timestamps.length && timestamps[i] < cutoff) i++;
  if (i > 0) {
    minuteWindows.set(key, timestamps.slice(i));
  }
}
export function incrementMinuteRequestCount(modelId) {
  if (!modelId) return;
  const key = stripModelPrefix(modelId);
  pruneMinuteWindow(key);
  const timestamps = minuteWindows.get(key) ?? [];
  timestamps.push(Date.now());
  minuteWindows.set(key, timestamps);
}
export function getMinuteRequestCount(modelId) {
  if (!modelId) return 0;
  const key = stripModelPrefix(modelId);
  pruneMinuteWindow(key);
  return minuteWindows.get(key)?.length ?? 0;
}
export function isRpmExhausted(modelId) {
  const rpm = getModelRpm(modelId);
  if (rpm <= 0) return false;
  return getMinuteRequestCount(modelId) >= rpm;
}

// ── Increment both (convenience) ─────────────────────────────────────────────

/** Increment both daily and minute counters for a Gemini request. */
export function incrementRequestCount(modelId) {
  incrementDailyRequestCount(modelId);
  incrementMinuteRequestCount(modelId);
}

// ── Reset (testing) ──────────────────────────────────────────────────────────

export function resetCounters() {
  dailyCounts.clear();
  minuteWindows.clear();
}