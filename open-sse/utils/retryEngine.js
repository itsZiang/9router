import { RETRY_CONFIG, BACKOFF_CONFIG, HTTP_STATUS } from "../config/runtimeConfig.js";

/**
 * Status codes that are never retried, even if a config entry exists.
 * 400-class client errors indicate a problem with the request and will not
 * resolve by repeating the same payload.
 */
const NON_RETRYABLE_STATUSES = new Set([
  HTTP_STATUS.BAD_REQUEST,
  HTTP_STATUS.UNAUTHORIZED,
  HTTP_STATUS.PAYMENT_REQUIRED,
  HTTP_STATUS.FORBIDDEN,
  HTTP_STATUS.NOT_FOUND,
  HTTP_STATUS.NOT_ACCEPTABLE
]);

/**
 * Retry decision produced by RetryEngine.plan().
 * @typedef {object} RetryPlan
 * @property {boolean} retry - Whether the caller should schedule another attempt.
 * @property {number|null} delayMs - Delay before the next attempt (null when retry is false).
 * @property {string} reason - Human-readable reason for the decision.
 * @property {number} [maxRetries] - Configured attempt limit for the matched status.
 */

export class RetryEngine {
  /**
   * @param {object} [options]
   * @param {number} [options.maxAttempts=Infinity] - Global ceiling across all statuses.
   * @param {string} [options.backoff='fixed'] - Default backoff strategy: 'fixed', 'exponential', 'exponential_jitter'.
   * @param {object} [options.perStatusConfig={}] - Map of status code -> { attempts, delayMs, backoff }.
   * @param {number} [options.maxDelayMs=BACKOFF_CONFIG.max] - Hard cap for any computed delay.
   * @param {boolean} [options.honorRetryAfter=true] - Honor upstream Retry-After headers.
   * @param {() => number} [options.random=Math.random] - Random source for jitter (injectable for tests).
   */
  constructor({
    maxAttempts = Infinity,
    backoff = "fixed",
    perStatusConfig = {},
    maxDelayMs = BACKOFF_CONFIG.max,
    honorRetryAfter = true,
    random = Math.random
  } = {}) {
    this.maxAttempts = Number.isFinite(maxAttempts) && maxAttempts > 0 ? maxAttempts : Infinity;
    this.backoff = backoff;
    this.maxDelayMs = maxDelayMs > 0 ? maxDelayMs : BACKOFF_CONFIG.max;
    this.honorRetryAfter = honorRetryAfter;
    this.random = typeof random === "function" ? random : Math.random;
    this.perStatusConfig = {};
    for (const [rawStatus, entry] of Object.entries(perStatusConfig)) {
      const status = Number(rawStatus);
      if (Number.isFinite(status)) {
        this.perStatusConfig[status] = this.normalizeEntry(entry);
      }
    }
  }

  normalizeEntry(entry) {
    if (entry == null) {
      return { attempts: 0, delayMs: RETRY_CONFIG.delayMs, backoff: this.backoff };
    }
    if (typeof entry === "number") {
      return { attempts: entry, delayMs: RETRY_CONFIG.delayMs, backoff: this.backoff };
    }
    return {
      attempts: entry.attempts ?? 0,
      delayMs: entry.delayMs ?? RETRY_CONFIG.delayMs,
      backoff: entry.backoff ?? this.backoff
    };
  }

  getConfig(status) {
    return this.perStatusConfig[Number(status)] || null;
  }

  /**
   * Parse Retry-After style header values (seconds or HTTP date).
   * Also understands x-ratelimit-reset-after (seconds) and x-ratelimit-reset
   * (Unix seconds) as a courtesy for common provider extensions.
   * @param {Response|{headers: {get: (name: string) => string|null}}} response
   * @returns {number|null} Delay in milliseconds, or null if not present/invalid.
   */
  parseRetryAfter(response) {
    if (!response?.headers?.get) return null;
    const headers = response.headers;

    const retryAfter = headers.get("retry-after") || headers.get("Retry-After");
    if (retryAfter) {
      const seconds = parseInt(retryAfter, 10);
      if (!isNaN(seconds) && seconds >= 0) return seconds * 1000;

      const date = new Date(retryAfter);
      if (!isNaN(date.getTime())) {
        const diff = date.getTime() - Date.now();
        return diff > 0 ? diff : 0;
      }
    }

    const resetAfter = headers.get("x-ratelimit-reset-after");
    if (resetAfter) {
      const seconds = parseInt(resetAfter, 10);
      if (!isNaN(seconds) && seconds >= 0) return seconds * 1000;
    }

    const resetTimestamp = headers.get("x-ratelimit-reset");
    if (resetTimestamp) {
      const ts = parseInt(resetTimestamp, 10) * 1000;
      const diff = ts - Date.now();
      return diff > 0 ? diff : 0;
    }

    return null;
  }

  /**
   * Decide whether and how long to wait before retrying.
   * @param {object} params
   * @param {number} params.status - HTTP status or mapped status (e.g. 502 for network errors).
   * @param {Error} [params.error] - Original error (used only for logging/classification context).
   * @param {number} [params.attempt=1] - 1-based attempt number for the next retry.
   * @param {Response|null} [params.response] - Upstream response, when available.
   * @param {Function|null} [params.customDelay] - Optional async (response, attempt, baseDelayMs) -> number|false|null.
   * @returns {Promise<RetryPlan>}
   */
  async plan({ status, error, attempt = 1, response = null, customDelay = null }) {
    const statusNum = Number(status);
    if (!Number.isFinite(statusNum)) {
      return { retry: false, delayMs: null, reason: "invalid-status" };
    }

    if (NON_RETRYABLE_STATUSES.has(statusNum)) {
      return { retry: false, delayMs: null, reason: "non-retryable-status" };
    }

    const cfg = this.getConfig(statusNum);
    if (!cfg || cfg.attempts <= 0) {
      return { retry: false, delayMs: null, reason: "no-retry-config" };
    }

    if (attempt > cfg.attempts || attempt > this.maxAttempts) {
      return { retry: false, delayMs: null, reason: "attempts-exhausted", maxRetries: Math.min(cfg.attempts, this.maxAttempts) };
    }

    // Subclass hook takes precedence when it returns a concrete delay or vetoes.
    if (typeof customDelay === "function") {
      try {
        const dynamic = await customDelay(response, attempt, cfg.delayMs);
        if (dynamic === false) {
          return { retry: false, delayMs: null, reason: "custom-delay-veto", maxRetries: cfg.attempts };
        }
        if (typeof dynamic === "number" && dynamic >= 0) {
          return { retry: true, delayMs: Math.min(dynamic, this.maxDelayMs), reason: "custom-delay", maxRetries: cfg.attempts };
        }
      } catch {
        // Fall through to policy-based delay.
      }
    }

    // Honor upstream Retry-After before applying our own backoff.
    if (this.honorRetryAfter && response) {
      const retryAfterMs = this.parseRetryAfter(response);
      if (retryAfterMs != null) {
        return {
          retry: true,
          delayMs: Math.min(retryAfterMs, this.maxDelayMs),
          reason: "retry-after",
          maxRetries: cfg.attempts
        };
      }
    }

    let delayMs;
    switch (cfg.backoff) {
      case "exponential_jitter": {
        const base = cfg.delayMs * 2 ** (attempt - 1);
        delayMs = Math.floor(base / 2 + this.random() * (base / 2));
        break;
      }
      case "exponential": {
        delayMs = cfg.delayMs * 2 ** (attempt - 1);
        break;
      }
      case "fixed":
      default:
        delayMs = cfg.delayMs;
    }

    return {
      retry: true,
      delayMs: Math.min(delayMs, this.maxDelayMs),
      reason: cfg.backoff,
      maxRetries: cfg.attempts
    };
  }
}

export default RetryEngine;
