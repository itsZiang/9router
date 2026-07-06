/**
 * Sliding-window rate limiter (free-claude-code port, Fase 8.2).
 *
 * A small, dependency-free fallback limiter for providers that do NOT expose
 * rate-limit headers (so the adaptive Bottleneck path in rateLimitManager never
 * learns a reservoir) but have a documented fixed cap. Bottleneck's reservoir is a
 * fixed-window counter that refills in one burst every interval; a true sliding
 * window enforces "no more than N requests in ANY trailing windowMs", which avoids
 * the 2× burst at window boundaries that can trip an upstream 429.
 *
 * It is intentionally a pure allowed/blocked oracle (no internal queueing) — the
 * caller decides whether to wait `retryAfterMs` or fall back. See
 * `withRateLimit` in rateLimitManager.ts for the opt-in wiring, gated on
 * PROVIDER_DEFAULT_RATE_LIMITS so existing providers are unaffected.
 */

// Hard ceiling on distinct keys tracked, so a pathological key space (e.g. a
// per-request id leaking into the key) can never grow the map without bound.
const MAX_KEYS = 5000;
export class SlidingWindowLimiter {
  hits = new Map();
  now;
  constructor(opts = {}) {
    this.now = opts.now ?? Date.now;
  }

  /**
   * Try to consume one slot for `key`. Records a timestamp and returns
   * `{allowed:true}` when under the cap; returns `{allowed:false, retryAfterMs}`
   * (without recording) when the trailing window is saturated.
   */
  tryAcquire(key, window) {
    const {
      requests,
      windowMs
    } = window;
    // A non-positive cap or window means "no limit configured" → always allow.
    if (!(requests > 0) || !(windowMs > 0)) return {
      allowed: true,
      retryAfterMs: 0
    };
    const now = this.now();
    const cutoff = now - windowMs;
    const previous = this.hits.get(key);
    // Drop timestamps that have aged out of the trailing window.
    const live = previous ? previous.filter(ts => ts > cutoff) : [];
    if (live.length >= requests) {
      // The oldest in-window hit is the first to expire and free a slot.
      const retryAfterMs = Math.max(0, live[0] + windowMs - now);
      this.hits.set(key, live); // persist the pruned list; do NOT record a blocked attempt
      return {
        allowed: false,
        retryAfterMs
      };
    }
    live.push(now);
    this.set(key, live);
    return {
      allowed: true,
      retryAfterMs: 0
    };
  }

  /** Clear history for one key, or all keys when called with no argument. */
  reset(key) {
    if (key === undefined) this.hits.clear();else this.hits.delete(key);
  }
  set(key, live) {
    if (!this.hits.has(key) && this.hits.size >= MAX_KEYS) {
      // Evict the least-recently-inserted key (Map preserves insertion order).
      const oldest = this.hits.keys().next().value;
      if (oldest !== undefined) this.hits.delete(oldest);
    }
    this.hits.set(key, live);
  }
}