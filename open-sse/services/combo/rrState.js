/**
 * Round-robin sticky state for combo routing.
 *
 * Holds the two mutable module-level Maps that back round-robin distribution
 * (`rrCounters`) and sticky round-robin target affinity (`rrStickyTargets`),
 * plus the helpers that read/write them. Extracted byte-identically from
 * combo.ts (QG v2 Fase 9 T5 D7a).
 *
 * State cohesion: these two Maps MUST remain single instances. combo.ts imports
 * the same references back and mutates them directly (orderTargetsByResetAwareQuota,
 * orderTargetsByResetWindow, handleRoundRobinCombo) — never duplicate a Map.
 *
 * Pure leaf: this module never imports from the combo barrel.
 */

// In-memory atomic counter per combo for round-robin distribution
// Resets on server restart (by design — no stale state)
// Eviction limits to prevent unbounded memory growth
export const MAX_RR_COUNTERS = 500;
export const rrCounters = new Map();
export const rrStickyTargets = new Map();
export const weightedStickyTargets = new Map();
export function clampStickyRoundRobinTargetLimit(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return 1;
  return Math.min(Math.max(Math.floor(numericValue), 1), 1000);
}
export const clampStickyWeightedTargetLimit = clampStickyRoundRobinTargetLimit;
export function getStickyRoundRobinStartIndex(comboName, targets, stickyLimit) {
  const sticky = rrStickyTargets.get(comboName);
  const stickyIndex = sticky ? targets.findIndex(target => target.executionKey === sticky.executionKey) : -1;
  if (stickyLimit > 1 && sticky && stickyIndex >= 0 && sticky.successCount < stickyLimit) {
    return {
      startIndex: stickyIndex,
      counter: rrCounters.get(comboName) || 0
    };
  }
  const counter = rrCounters.get(comboName) || 0;
  return {
    startIndex: counter % targets.length,
    counter
  };
}
export function recordStickyRoundRobinSuccess(comboName, target, stickyLimit, targets) {
  const sticky = rrStickyTargets.get(comboName);
  const successCount = sticky?.executionKey === target.executionKey ? sticky.successCount + 1 : 1;
  if (successCount >= stickyLimit) {
    const servedIndex = targets.findIndex(entry => entry.executionKey === target.executionKey);
    rrCounters.set(comboName, servedIndex >= 0 ? servedIndex + 1 : (rrCounters.get(comboName) || 0) + 1);
    rrStickyTargets.delete(comboName);
    return;
  }
  rrStickyTargets.set(comboName, {
    executionKey: target.executionKey,
    successCount
  });
}
export function getStickyWeightedExecutionKey(comboName, stickyLimit) {
  const sticky = weightedStickyTargets.get(comboName);
  if (!sticky || stickyLimit <= 1 || sticky.successCount >= stickyLimit) return null;
  return sticky.executionKey;
}
export function recordStickyWeightedSuccess(comboName, executionKey, stickyLimit) {
  const sticky = weightedStickyTargets.get(comboName);
  const successCount = sticky?.executionKey === executionKey ? sticky.successCount + 1 : 1;
  if (successCount >= stickyLimit) {
    weightedStickyTargets.delete(comboName);
    return;
  }
  weightedStickyTargets.set(comboName, {
    executionKey,
    successCount
  });
}