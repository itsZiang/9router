/**
 * Session Pool — Type Definitions
 *
 * Core types for the anonymous session pool system:
 *   SessionPool  → manages N sessions, each with a unique browser fingerprint
 *   Fingerprint  → UA + headers for one browser-like identity
 *   Session      → state machine tracking one session through its lifecycle
 *   PoolConfig   → hot-reloadable pool parameters
 *   PoolStats    → real-time pool health snapshot
 */

// ─── Fingerprint Types ─────────────────────────────────────────────────────

// ─── Session Types ─────────────────────────────────────────────────────────

// ─── Pool Types ────────────────────────────────────────────────────────────

// ─── Defaults ──────────────────────────────────────────────────────────────

export const DEFAULT_POOL_CONFIG = {
  minSessions: 6,
  maxSessions: 20,
  cooldownBase: 1_000,
  cooldownMax: 30_000,
  cooldownJitter: 5_000,
  requestTimeout: 30_000,
  requestJitter: 50
};