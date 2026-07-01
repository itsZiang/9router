# ADR: 9Router Core Upgrade — Learning from LiteLLM

**Status:** Accepted  
**Date:** 2026-07-01  
**Author:** OpenCode / 9Router team  
**Reference target:** LiteLLM 1.90.0

---

## Context

9Router is a Node.js/Next.js AI gateway that routes requests from coding tools (Claude Code, Cursor, Codex, etc.) to 40+ upstream providers. Its strengths are:

- A provider-agnostic translator engine (OpenAI as pivot + direct format routes).
- RTK token saver.
- Specialized executors for non-standard providers (Cursor protobuf, Kiro EventStream, Codex Responses).
- Account-level fallback/round-robin and OAuth token refresh.
- A streaming stall watchdog and disconnect detection.

However, compared to LiteLLM 1.90.0, 9Router's core lacks:

- A reusable, pooled HTTP client.
- A pluggable provider abstraction.
- A structured retry engine with backoff/jitter and `Retry-After` handling.
- Deployment health tracking, TPM/RPM-aware routing, and automatic cooldown.
- A standardized error taxonomy and key masking.
- An in-memory dual cache and request context propagation.

LiteLLM separates concerns cleanly: the SDK owns provider translation, HTTP, streaming normalization, and retry primitives; the proxy owns auth, rate limits, spend tracking, and DB persistence. We want to bring similar reliability patterns into 9Router without rewriting its translator engine or forcing every executor to change overnight.

---

## Decision

We will upgrade 9Router's core through a **7-phase soft migration**:

1. **Unified Provider Interface (soft migration)** — add a LiteLLM-style `BaseProviderConfig`, but keep `BaseExecutor.execute()` intact so specialized executors continue to work.
2. **HTTP Client Cache & Connection Pool** — cache `undici` agents, add explicit first-chunk timeout.
3. **Retry Engine v2** — configurable retry policy, exponential backoff + jitter, `Retry-After` parsing, error classification.
4. **Router Reliability Layer (in-memory)** — deployment health tracking, auto-cooldown, TPM/RPM tracker, selection strategies.
5. **Streaming Normalization** — provider-specific response iterators, normalized chunk shape.
6. **Error Taxonomy & Masking** — `NineRouterError` hierarchy, classifier, API-key masking.
7. **In-Memory Dual Cache & Request Context** — TTL cache, request context, response metadata headers.

### Non-goals / constraints

- **No Redis.** All caching, counters, and health state stay in-process memory.
- **No background workers.** Health-check probes and batched DB logging are deferred.
- **No hard breaking changes to specialized executors.** Cursor, Kiro, Codex, etc. keep their existing `execute()` implementations until explicitly migrated.
- **No change to the translator engine's public behavior.** Direct routes and OpenAI pivot remain unchanged.

---

## Consequences

### Positive

- **Better resource usage:** Cached HTTP agents reduce per-request connection setup cost.
- **Higher reliability:** Structured retry + health tracking + auto-cooldown reduces user-visible failures.
- **Cleaner provider model:** New OpenAI-compatible providers can be added via registry config without writing an executor.
- **Safer errors:** API keys/tokens will be masked before logging or returning to clients.
- **Better observability:** Response headers will expose request metadata and retry counts.

### Negative / trade-offs

- **In-memory state is lost on restart.** Without Redis, cooldowns, TPM/RPM counters, and cache disappear when the process restarts. This is acceptable for the current scope.
- **Soft migration adds temporary duplication.** Some logic will exist in both the old executor path and the new `ProviderConfig` path until all executors migrate.
- **More code to maintain.** New subsystems (retry engine, health tracker, cache) require ongoing care and tests.
- **Pool changes proxy connection behavior.** The old code forced `Connection: close` on every proxied request to rotate proxy IPs; the new pooled agent keeps connections alive. Users that need per-request IP rotation must use multiple proxy URLs instead of a single proxy with connection close.

## Phase 2 — HTTP Client Cache & Connection Pool (implemented)

### Decision

- Cache `undici.Agent` and `undici.ProxyAgent` instances in `HttpClientCache`, keyed by `(proxyUrl, connectTimeout, keepAliveTimeout, poolLimit, poolLimitPerHost)`.
- Force `bodyTimeout: 0` and `headersTimeout: 0` on all cached agents so long reasoning streams are never killed by undici's default 300 s timeout.
- Add an explicit `withFirstChunkTimeout` wrapper that aborts a stream if no bytes arrive within `STREAM_FIRST_CHUNK_TIMEOUT_MS`.
- Apply the first-chunk timeout only when the request `Accept` header is `text/event-stream`, leaving non-streaming fetches (OAuth refresh, embeddings, TTS) untouched.
- Expose pool/timeout env overrides: `NINEROUTER_HTTP_POOL_LIMIT`, `NINEROUTER_HTTP_POOL_LIMIT_PER_HOST`, `NINEROUTER_KEEPALIVE_TIMEOUT`, `NINEROUTER_DNS_TTL`, plus `NINEROUTER_HTTP_CLIENT_CACHE_TTL` for cache eviction.

### Consequences

- TCP/TLS setup cost is amortized across requests that hit the same cache key.
- Time-to-first-token failures surface as explicit `TimeoutError`s instead of silent stream hangs.
- The global `httpClientCache` singleton is testable via `clear()` and `size()`; tests can construct isolated caches with `new HttpClientCache(...)`.
- Removing per-request `Connection: close` improves throughput but changes proxy-rotation behavior, as noted above.

---

## Phase 3 — Retry Engine v2 (implemented)

### Decision

- Introduce a stateless `RetryEngine` (`open-sse/utils/retryEngine.js`) that classifies errors and computes retry delays.
- Support backoff strategies: `fixed`, `exponential`, `exponential_jitter`.
- Parse `Retry-After` (seconds or HTTP date), plus `x-ratelimit-reset-after` and `x-ratelimit-reset`.
- Treat 400/401/403/404/406 as non-retryable regardless of config.
- Integrate the engine into `BaseExecutor.execute()` while preserving the existing `retry` config shape and the `computeRetryDelay` subclass hook.
- Surface retry counts in response headers via `chatCore.js`:
  - `x-9router-attempted-retries`
  - `x-9router-max-retries`
- Default policy: 429 uses `exponential_jitter` (3 attempts, 1 s base); 502/503/504/524 keep fixed backoff.

### Consequences

- Retry logic is centralized, configurable, and testable independent of the executor loop.
- Upstream `Retry-After` values are honored, reducing unnecessary retry storms during provider rate limits.
- Non-retryable client errors (400-class) fail fast instead of wasting attempts.
- The existing `computeRetryDelay` hook continues to work, so Antigravity's provider-specific retry logic is unchanged.

---

## Alternatives Considered

### 1. Hard refactor of all executors

Replace every executor with a strict `BaseProviderConfig` implementation.

- **Rejected:** Too risky. 24+ executors and 30–50 test files would need immediate changes. Specialized stream parsers (Cursor protobuf, Kiro EventStream) are easy to break.

### 2. Switch from undici to httpx via a Node wrapper

Adopt a Python-like HTTP client stack.

- **Rejected:** 9Router already uses undici effectively. The gain does not justify swapping the transport layer. We will improve pooling and timeout handling within undici instead.

### 3. Add Redis immediately

Use Redis for DualCache, TPM/RPM, and health state.

- **Rejected:** Adds operational complexity and a new runtime dependency. The user explicitly requested in-memory. Redis can be added later as a backend option.

### 4. Build a separate worker process for health checks

Run background health probes and batched logging outside the Next.js process.

- **Rejected:** Out of scope for this upgrade. Will be reconsidered when health checks/logging batching are prioritized.

---

## References

- `9router/PLAN-core-upgrade.md` — detailed phase-by-phase work breakdown.
- `9router/open-sse/AGENTS.md` — coding conventions for the `open-sse` package.
- `litellm-1.90.0/ARCHITECTURE.md` — LiteLLM architecture overview.
- Key LiteLLM files studied:
  - `litellm/router.py` — retries, fallbacks, cooldowns, TPM/RPM.
  - `litellm/llms/custom_httpx/llm_http_handler.py` — provider abstraction.
  - `litellm/llms/custom_httpx/http_handler.py` — HTTP client pooling.
  - `litellm/litellm_core_utils/streaming_handler.py` — stream normalization.
  - `litellm/exceptions.py` — error taxonomy.
