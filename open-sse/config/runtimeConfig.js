// HTTP status codes
export const HTTP_STATUS = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  PAYMENT_REQUIRED: 402,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  NOT_ACCEPTABLE: 406,
  REQUEST_TIMEOUT: 408,
  RATE_LIMITED: 429,
  SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504
};

// Re-export error config (backward compat)
import { BACKOFF_CONFIG } from "./errorConfig.js";
export { ERROR_TYPES, DEFAULT_ERROR_MESSAGES, BACKOFF_CONFIG, COOLDOWN_MS } from "./errorConfig.js";

// Cache TTLs (seconds)
export const CACHE_TTL = {
  userInfo: 300,    // 5 minutes
  modelAlias: 3600  // 1 hour
};

// Memory management config
export const MEMORY_CONFIG = {
  sessionTtlMs: 2 * 60 * 60 * 1000,
  sessionCleanupIntervalMs: 30 * 60 * 1000,
  dnsCacheTtlMs: 5 * 60 * 1000,
  proxyDispatchersMaxSize: 20,
};

// Parse a positive integer env override, falling back to a default.
function envMs(name, def) {
  const raw = process.env[name];
  if (raw == null || raw === "") return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

// Parse a positive integer env override (unitless), falling back to a default.
function envInt(name, def) {
  const raw = process.env[name];
  if (raw == null || raw === "") return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

// Inter-chunk stall timeout (once tokens are flowing). Generous headroom so
// slow reasoning models aren't aborted mid-stream. Env: STREAM_STALL_TIMEOUT_MS.
export const STREAM_STALL_TIMEOUT_MS = envMs("STREAM_STALL_TIMEOUT_MS", 360 * 1000);

// Max consecutive identical content chunks before aborting (loop detection).
// Prevents misbehaving providers from emitting the same token in an infinite
// loop. Matches LiteLLM's repetition warning threshold. Env: STREAM_LOOP_THRESHOLD.
export const STREAM_LOOP_THRESHOLD = envInt("STREAM_LOOP_THRESHOLD", 100);

// Time-to-first-token timeout (prompt prefill). Env: STREAM_FIRST_CHUNK_TIMEOUT_MS.
export const STREAM_FIRST_CHUNK_TIMEOUT_MS = envMs("STREAM_FIRST_CHUNK_TIMEOUT_MS", 200 * 1000);

// Fetch connect timeout: abort if upstream doesn't return response headers within this duration
export const FETCH_CONNECT_TIMEOUT_MS = envMs("FETCH_CONNECT_TIMEOUT_MS", 60 * 1000);

// HTTP client connection-pool configuration.
// Env overrides mirror LiteLLM-style pool limits; values are cached per
// (proxyUrl, connectTimeout, keepAliveTimeout, poolLimit).
export const HTTP_POOL_LIMIT = envInt("NINEROUTER_HTTP_POOL_LIMIT", 100);
// Deprecated: undici does not support per-host connection limits natively.
// Only the global `HTTP_POOL_LIMIT` is enforced. Kept for backward compat.
export const HTTP_POOL_LIMIT_PER_HOST = envInt("NINEROUTER_HTTP_POOL_LIMIT_PER_HOST", 10);
export const HTTP_KEEPALIVE_TIMEOUT_MS = envMs("NINEROUTER_KEEPALIVE_TIMEOUT", 60 * 1000);
export const HTTP_DNS_TTL_MS = envMs("NINEROUTER_DNS_TTL", MEMORY_CONFIG.dnsCacheTtlMs);
export const HTTP_CLIENT_CACHE_TTL_MS = envMs("NINEROUTER_HTTP_CLIENT_CACHE_TTL", 10 * 60 * 1000);

// Gemini native TTS fetch timeout: abort if Google does not return response headers in time.
export const GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS = envMs("GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS", 45 * 1000);

// Default token limits
export const DEFAULT_MAX_TOKENS = 64000;
export const DEFAULT_MIN_TOKENS = 32000;

// Retry config for 429 responses (legacy - kept for backward compatibility)
export const RETRY_CONFIG = {
  maxAttempts: 2,
  delayMs: 2000
};

// Default retry config by status code: { attempts, delayMs, backoff }
// Backward compat: if value is a number, treated as attempts with RETRY_CONFIG.delayMs and 'fixed' backoff.
export const DEFAULT_RETRY_CONFIG = {
  429: { attempts: 3, delayMs: 1000, backoff: "exponential_jitter" },
  502: { attempts: 3, delayMs: 3000, backoff: "fixed" },
  503: { attempts: 3, delayMs: 2000, backoff: "fixed" },
  504: { attempts: 2, delayMs: 3000, backoff: "fixed" },
  524: { attempts: 2, delayMs: 3000, backoff: "fixed" }
};

// Normalize a retry entry to { attempts, delayMs, backoff }
export function resolveRetryEntry(entry) {
  if (entry == null) return { attempts: 0, delayMs: RETRY_CONFIG.delayMs, backoff: "fixed" };
  if (typeof entry === "number") return { attempts: entry, delayMs: RETRY_CONFIG.delayMs, backoff: "fixed" };
  return {
    attempts: entry.attempts ?? 0,
    delayMs: entry.delayMs ?? RETRY_CONFIG.delayMs,
    backoff: entry.backoff || "fixed"
  };
}

// Requests containing these texts will bypass provider
export const SKIP_PATTERNS = [
  "Please write a 5-10 word title for the following conversation:"
];
