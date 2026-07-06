/**
 * Provider Cooldown Tracker
 *
 * Global, cross-request cooldown state for failed providers/connections.
 * Prevents subsequent combo requests from re-walking the same failing
 * providers by remembering failure timestamps and enforcing a configurable
 * minimum/maximum cooldown window.
 */

import { DEFAULT_RESILIENCE_SETTINGS } from "../stubs/lib/resilience/settings";
// Global cooldown state: keyed by "provider:connectionId" or "provider"
const cooldownMap = new Map();

// Evict entries older than their configured retention horizon to prevent
// unbounded memory growth without shortening operator-configured cooldowns.
const DEFAULT_ENTRY_RETENTION_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000; // Cleanup every 60s

let cleanupTimer = null;
function startCleanupIfNeeded() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    cleanupExpiredCooldownEntries();
  }, CLEANUP_INTERVAL_MS);
  // Allow Node.js to exit even if the timer is running
  if (cleanupTimer.unref) cleanupTimer.unref();
}
function getEntryRetentionMs(settings) {
  const maxRetryCooldownMs = settings?.providerCooldown?.maxRetryCooldownMs ?? DEFAULT_RESILIENCE_SETTINGS.providerCooldown.maxRetryCooldownMs;
  return Math.max(DEFAULT_ENTRY_RETENTION_MS, maxRetryCooldownMs);
}

/**
 * Remove expired cooldown entries using each entry's configured retention
 * horizon. Exported for diagnostics and focused tests; normal runtime cleanup is
 * still performed by the unref'd interval started on first cooldown record.
 */
export function cleanupExpiredCooldownEntries(now = Date.now()) {
  for (const [key, entry] of cooldownMap) {
    if (now - entry.lastFailureAt > entry.retentionMs) {
      cooldownMap.delete(key);
    }
  }
}

/**
 * Build a cooldown key from provider and optional connectionId.
 */
function cooldownKey(provider, connectionId) {
  return connectionId ? `${provider}:${connectionId}` : provider;
}

/**
 * Record a failure for a provider/connection.
 *
 * @param provider - Provider ID (e.g. "openai", "anthropic")
 * @param connectionId - Optional connection ID for per-connection tracking
 * @param settings - Resilience settings for cooldown configuration
 */
export function recordProviderCooldown(provider, connectionId, settings) {
  if (!provider || provider === "unknown") return;
  const key = cooldownKey(provider, connectionId);
  const existing = cooldownMap.get(key);
  const now = Date.now();
  const retentionMs = getEntryRetentionMs(settings);
  if (existing) {
    existing.lastFailureAt = now;
    existing.failureCount++;
    existing.retentionMs = Math.max(existing.retentionMs, retentionMs);
  } else {
    cooldownMap.set(key, {
      lastFailureAt: now,
      failureCount: 1,
      retentionMs
    });
  }
  startCleanupIfNeeded();
}

/**
 * Check if a provider/connection is currently in cooldown and should be skipped.
 *
 * @param provider - Provider ID
 * @param connectionId - Optional connection ID
 * @param settings - Resilience settings for cooldown configuration
 * @returns true if the provider should be skipped (still in cooldown)
 */
export function isProviderInCooldown(provider, connectionId, settings) {
  if (!provider || provider === "unknown") return false;
  const key = cooldownKey(provider, connectionId);
  const entry = cooldownMap.get(key);
  if (!entry) return false;
  if (entry.failureCount === 0) return false;
  const now = Date.now();
  const elapsed = now - entry.lastFailureAt;
  const minCooldownMs = settings?.providerCooldown?.minRetryCooldownMs ?? DEFAULT_RESILIENCE_SETTINGS.providerCooldown.minRetryCooldownMs;
  const maxCooldownMs = settings?.providerCooldown?.maxRetryCooldownMs ?? DEFAULT_RESILIENCE_SETTINGS.providerCooldown.maxRetryCooldownMs;
  const exponent = Math.min(Math.max(0, entry.failureCount - 1), 10);
  const scaledCooldownMs = Math.min(minCooldownMs * Math.pow(2, exponent), maxCooldownMs);
  return elapsed < scaledCooldownMs;
}

/**
 * Get the remaining cooldown time for a provider/connection.
 * Returns 0 if not in cooldown.
 */
export function getRemainingCooldownMs(provider, connectionId, settings) {
  if (!provider || provider === "unknown") return 0;
  const key = cooldownKey(provider, connectionId);
  const entry = cooldownMap.get(key);
  if (!entry) return 0;
  const now = Date.now();
  const elapsed = now - entry.lastFailureAt;
  const minCooldownMs = settings?.providerCooldown?.minRetryCooldownMs ?? DEFAULT_RESILIENCE_SETTINGS.providerCooldown.minRetryCooldownMs;
  const maxCooldownMs = settings?.providerCooldown?.maxRetryCooldownMs ?? DEFAULT_RESILIENCE_SETTINGS.providerCooldown.maxRetryCooldownMs;
  const exponent = Math.min(Math.max(0, entry.failureCount - 1), 10);
  const scaledCooldownMs = Math.min(minCooldownMs * Math.pow(2, exponent), maxCooldownMs);
  const remaining = scaledCooldownMs - elapsed;
  return remaining > 0 ? remaining : 0;
}

/**
 * Record a successful request for a provider/connection.
 * Resets the failure count (but keeps the entry for reference).
 */
export function recordProviderSuccess(provider, connectionId) {
  if (!provider || provider === "unknown") return;
  const key = cooldownKey(provider, connectionId);
  const entry = cooldownMap.get(key);
  if (entry) {
    // Reset failure count but keep the entry
    entry.failureCount = 0;
  }
}

/**
 * Clear all cooldown state. Useful for testing or manual reset.
 */
export function clearCooldownState() {
  cooldownMap.clear();
}

/**
 * Get the number of entries in the cooldown map (for diagnostics).
 */
export function getCooldownEntryCount() {
  return cooldownMap.size;
}