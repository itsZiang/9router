# 9Router Core Upgrade Plan

**Goal:** Strengthen 9Router's core (streaming, connection handling, retry, performance, unified API) by borrowing proven patterns from LiteLLM 1.90.0, while preserving 9Router's existing translator engine, RTK token saver, and specialized executors.

**Scope:** In-memory only (no Redis/background workers). Soft migration of provider/executor interface. Health-check/batched-logging deferred.

**Test framework:** Vitest (see `tests/vitest.config.js`).

**Reference target:** LiteLLM 1.90.0 — specifically `litellm/router.py`, `litellm/llms/custom_httpx/llm_http_handler.py`, `litellm/llms/custom_httpx/http_handler.py`, `litellm/litellm_core_utils/streaming_handler.py`, `litellm/exceptions.py`.

---

## Principles

1. **Soft migration:** Keep `BaseExecutor.execute()` public API intact. Specialized executors (Cursor, Kiro, Codex, …) continue to work unchanged until explicitly migrated.
2. **Config-driven:** All new constants, timeouts, limits live in `open-sse/config/`. No hard-coded values in business logic.
3. **In-memory:** Dual cache, TPM/RPM, health state, and request scheduling use in-memory data structures only.
4. **Backward compatible:** Existing routes, handlers, registry configs, and translator paths keep working.
5. **Observability by design:** Every request carries a context object and returns metadata headers.

---

## Phase Summary

| Phase | Focus | Key Deliverables | Compact Checkpoint |
|-------|-------|------------------|-------------------|
| 1 | Unified Provider Interface (soft migration) | `BaseProviderConfig`, `DefaultProviderConfig`, refactored `DefaultExecutor` | [Phase 1](#phase-1-unified-provider-interface-soft-migration) |
| 2 | HTTP Client Cache & Connection Pool | `HttpClientCache`, cached undici agents, first-chunk timeout | [Phase 2](#phase-2-http-client-cache--connection-pool) |
| 3 | Retry Engine v2 | `RetryEngine`, retry policy, exponential backoff + jitter, Retry-After parsing | [Phase 3](#phase-3-retry-engine-v2) |
| 4 | Router Reliability Layer (in-memory) | `DeploymentHealthTracker`, `TpmRpmTracker`, auto-cooldown, weighted strategies | [Phase 4](#phase-4-router-reliability-layer-in-memory) |
| 5 | Streaming Normalization | `BaseResponseIterator`, provider-specific iterators, normalized SSE chunks | [Phase 5](#phase-5-streaming-normalization) |
| 6 | Error Taxonomy & Masking | `NineRouterError` classes, error classifier, API-key masking | [Phase 6](#phase-6-error-taxonomy--masking) |
| 7 | In-memory Dual Cache & Request Context | `DualCache`, `RequestContext`, response metadata headers | [Phase 7](#phase-7-in-memory-dual-cache--request-context) |

---

## Phase 1 — Unified Provider Interface (Soft Migration)

**Objective:** Introduce a LiteLLM-style `BaseProviderConfig` abstraction without forcing existing executors to migrate.

### Work

1. Create `open-sse/providers/BaseProviderConfig.js`
   - Interface methods:
     - `validateEnvironment({ apiKey, apiBase, headers, model, messages, optionalParams })`
     - `buildUrl({ apiBase, apiKey, model, optionalParams, stream })`
     - `buildHeaders({ credentials, stream })`
     - `signRequest({ headers, requestData, apiKey })`
     - `transformRequest({ model, messages, optionalParams, stream, credentials })`
     - `transformResponse({ model, rawResponse, stream, credentials })`
     - `getResponseIterator({ rawResponse, model, stream })`
     - `parseError({ response, bodyText })`
2. Create `open-sse/providers/DefaultProviderConfig.js`
   - Implementation for OpenAI-compatible and Anthropic-compatible providers.
   - Supports `openai-compatible-*` and `anthropic-compatible-*` registry shapes.
3. Update `open-sse/executors/base.js`
   - Add optional `getProviderConfig()` hook returning `null` by default.
   - If hook returns a config, `execute()` delegates transform/build/sign to it.
   - Keep existing `transformRequest`/`buildUrl`/`buildHeaders` overrides working.
4. Update `open-sse/executors/default.js`
   - Return `new DefaultProviderConfig(provider, config)` from `getProviderConfig()`.
   - Remove duplicate header/url logic where possible.
5. Update `open-sse/handlers/chatCore.js`
   - If executor exposes a provider config, use it for request/response transformation.
   - Otherwise fall back to current translator path.

### Tests

- `tests/unit/provider-config-default.test.js`
- `tests/unit/executor-soft-migration.test.js`
- Ensure existing `tests/unit/base-executor-retry.test.js` still passes.

### Acceptance Criteria

- [x] `DefaultExecutor` works with OpenAI-compatible providers using only registry config.
- [x] Existing specialized executors require zero changes.
- [x] Existing translator tests still pass.

### Notes / Adjustments

- `chatCore.js` integration in Phase 1 is deliberately minimal: it becomes aware of the provider config (for logging and `parseError` via `utils/error.js`) but does **not** replace the translator pipeline. Replacing `translateRequest`/`translateResponse` with provider-config transforms will be revisited after streaming normalization and error taxonomy are in place.
- `DefaultExecutor` keeps backward-compatible `buildUrl`/`buildHeaders`/`transformRequest` wrappers that delegate to `DefaultProviderConfig`, so external callers and existing tests continue to work.

---

## Phase 2 — HTTP Client Cache & Connection Pool

**Objective:** Replace per-request fresh `undici.ProxyAgent` with cached agents and add explicit first-chunk timeout.

### Work

1. Create `open-sse/utils/httpClientCache.js`
   - Cache `undici.Agent` and `undici.ProxyAgent` instances by key.
   - Key includes: `proxyUrl`, `connectTimeout`, `keepAliveTimeout`, `poolLimit`, `poolLimitPerHost`.
   - TTL-based eviction (configurable, default 10 minutes).
   - Env overrides: `NINEROUTER_HTTP_POOL_LIMIT`, `NINEROUTER_HTTP_POOL_LIMIT_PER_HOST`, `NINEROUTER_KEEPALIVE_TIMEOUT`, `NINEROUTER_DNS_TTL`.
2. Update `open-sse/utils/proxyFetch.js`
   - Use `httpClientCache` instead of creating fresh agents.
   - Keep MITM DNS bypass path.
   - Add first-chunk timeout: abort if no byte received within `STREAM_FIRST_CHUNK_TIMEOUT_MS`.
3. Update `open-sse/config/runtimeConfig.js`
   - Add pool defaults and env parsers.
   - Confirm `STREAM_FIRST_CHUNK_TIMEOUT_MS` is wired into the fetch path.

### Tests

- `tests/unit/http-client-cache.test.js`
- `tests/unit/proxyFetch-first-chunk-timeout.test.js`
- Existing stream tests still pass.

### Acceptance Criteria

- [x] Reused agent reduces per-request overhead.
- [x] First-chunk timeout fires on deliberately slow mock upstream.
- [x] Long reasoning streams are not killed by undici default timeouts.

### Notes / Adjustments

- `poolLimitPerHost` is stored in the cache key for future per-host limiting; undici `Agent` currently uses `connections` as the total pool ceiling. Per-host enforcement can be layered later via a custom `factory` if operational data shows a need.
- The previous `connection: close` header on every proxied request was removed; connection reuse is the whole point of the pool. Providers/users that rely on per-request proxy IP rotation should use a proxy pool with distinct URLs rather than forcing a single proxy connection to close.
- First-chunk timeout is applied only when the request `Accept` header is `text/event-stream`, so non-streaming calls (OAuth refresh, embeddings, TTS) are not affected.
- Existing stream tests and all Phase 1/2 unit tests pass; full-suite failures are pre-existing (got-scraping path disabled, stale embeddings mocks, outdated registry expectations, etc.).

---

## Phase 3 — Retry Engine v2

**Objective:** Build a configurable retry engine with classification, backoff strategies, and Retry-After parsing.

### Work

1. Create `open-sse/utils/retryEngine.js`
   - `RetryEngine` class accepting:
     - `maxAttempts` (global)
     - `backoff` strategy: `fixed`, `exponential`, `exponential_jitter`
     - `perStatusConfig` map: `{ 429: { attempts: 3, delayMs: 1000, backoff: "exponential" } }`
   - `parseRetryAfter(response)` extracts delay from `Retry-After` header (seconds or HTTP date).
   - `shouldRetry({ status, error, attemptsUsed })` classification.
2. Update `open-sse/executors/base.js`
   - Replace inline retry loop with `RetryEngine`.
   - Preserve existing `retry` config shape for backward compatibility (adapter).
   - Surface retry metadata (`attemptedRetries`, `maxRetries`) to caller.
3. Update handlers to emit headers:
   - `x-9router-attempted-retries`
   - `x-9router-max-retries`
4. Allow retry policy in provider registry / settings.

### Tests

- `tests/unit/retry-engine.test.js`
- Update `tests/unit/base-executor-retry.test.js`.

### Acceptance Criteria

- [x] 429 retries with exponential backoff and jitter.
- [x] `Retry-After` header honored when present.
- [x] 400/401/403 raise immediately without retry.
- [x] Retry counts exposed in response headers.

### Notes / Adjustments

- `RetryEngine` is stateless and policy-driven. `BaseExecutor.execute()` still owns the retry loop and URL fallback logic; the engine only decides whether/when to retry.
- Default policy now retries 429 with `exponential_jitter` (3 attempts, 1 s base). Existing provider-specific configs (e.g. antigravity, kiro, vercel-ai-gateway) still override the default.
- 400/401/403/404/406 are treated as non-retryable even if a config entry attempts to retry them.
- `RetryEngine.parseRetryAfter()` supports `Retry-After` (seconds or HTTP date), `x-ratelimit-reset-after`, and `x-ratelimit-reset`.
- Retry metadata (`attemptedRetries`, `maxRetries`) is returned by `BaseExecutor.execute()` and propagated into response headers via `chatCore.js`:
  - `x-9router-attempted-retries`
  - `x-9router-max-retries`
- Existing `computeRetryDelay` subclass hook is preserved: it can override or veto the engine's delay decision.

---

## Phase 4 — Router Reliability Layer (In-Memory)

**Objective:** Add deployment health tracking, automatic cooldown, and simple TPM/RPM-aware selection.

### Work

1. Create `open-sse/services/deploymentHealth.js`
   - Track success/failure counts per `(provider, connectionId, model)` in sliding 1-minute windows.
   - Auto-cooldown a deployment when failures exceed `allowedFailsPerMinute`.
   - Cooldown duration precedence:
     1. `Retry-After` header
     2. Provider-specific cooldown
     3. Default `COOLDOWN_MS`
   - Provide `recordSuccess`, `recordFailure`, `isHealthy`, `getCooldownUntil`.
2. Create `open-sse/services/tpmRpmTracker.js`
   - In-memory TPM/RPM counters per `(provider, connectionId, model)` in sliding 1-minute windows.
   - Provide `incrementTpm`, `incrementRpm`, `getLoad`.
3. Update `src/sse/services/auth.js` (`getProviderCredentials`)
   - Filter out deployments in cooldown.
   - Add optional selection strategies:
     - `fill-first` (default)
     - `round-robin`
     - `lowest-tpm`
   - Integrate `DeploymentHealthTracker` and `TpmRpmTracker`.
4. Update `src/sse/handlers/chat.js`
   - Call `recordSuccess` / `recordFailure` after each attempt.

### Tests

- `tests/unit/deployment-health.test.js`
- `tests/unit/tpm-rpm-tracker.test.js`
- Update `tests/unit/combo-routing.test.js` if needed.

### Acceptance Criteria

- [ ] A deployment with 3 failures/minute is excluded from selection until cooldown expires.
- [ ] `lowest-tpm` strategy picks the least loaded deployment.
- [ ] Existing `fill-first` and `round-robin` still work.

---

## Phase 5 — Streaming Normalization

**Objective:** Separate provider-specific chunk parsing from response transformation and normalize chunks.

### Work

1. Create `open-sse/streaming/BaseResponseIterator.js`
   - Interface: `parseChunk(rawBytes)` returns normalized chunk or `null`.
   - Normalized chunk shape matches OpenAI `chat.completion.chunk`.
2. Create `open-sse/streaming/OpenAIResponseIterator.js`
   - SSE line parsing, `data: [DONE]` handling.
3. Update `DefaultProviderConfig` to return the right iterator via `getResponseIterator()`.
4. Update `open-sse/handlers/chatCore/streamingHandler.js`
   - If provider config provides an iterator, insert normalization before translation.
   - Keep passthrough path for executors without iterator.
5. Enforce `STREAM_FIRST_CHUNK_TIMEOUT_MS` in the streaming pipe.

### Tests

- `tests/unit/stream-iterator-openai.test.js`
- `tests/unit/stream-first-chunk-timeout.test.js`

### Acceptance Criteria

- [x] OpenAI SSE stream normalized to consistent chunk shape.
- [x] Tool call deltas aggregated across chunks (via normalized OpenAI chunk structure).
- [x] Finish reason and usage injected when available (passthrough path injects estimated usage on finish chunk; translate path delegates to existing usage extraction).
- [x] Specialized executors unchanged still stream correctly (new path only triggers when `getResponseIterator()` returns an instance; all others fall back to the legacy `createSSEStream`).

---

## Phase 6 — Error Taxonomy & Masking

**Objective:** Standardize errors, classify retryability, and mask sensitive data before logging or returning.

### Work

1. Create `open-sse/errors/NineRouterError.js`
   - Base class with fields: `type`, `code`, `statusCode`, `provider`, `model`, `retryable`.
2. Create subclasses:
   - `RateLimitError`
   - `AuthenticationError`
   - `ContextWindowExceededError`
   - `ContentPolicyError`
   - `BadGatewayError`
   - `TimeoutError`
   - `InvalidRequestError`
3. Create `open-sse/errors/errorClassifier.js`
   - Map status + message patterns to error subclass.
4. Update `open-sse/utils/error.js`
   - `buildErrorBody` uses taxonomy.
   - Add `maskSensitiveInfo(url, body, headers)` to strip API keys, tokens, authorization headers.
5. Update `BaseExecutor.execute()` to throw `NineRouterError` subclasses.

### Tests

- `tests/unit/error-taxonomy.test.js`
- `tests/unit/error-key-masking.test.js`

### Acceptance Criteria

- [ ] 429 → `RateLimitError`, retryable.
- [ ] 401/403 → `AuthenticationError`, not retryable.
- [ ] API keys/tokens removed from error messages and logs.

---

## Phase 7 — In-Memory Dual Cache & Request Context

**Objective:** Centralize in-memory caching and propagate request metadata across layers.

### Work

1. Create `open-sse/cache/DualCache.js`
   - Simple TTL cache with `get`, `set`, `delete`, `clear`, `has`.
   - Used for model locks, API key cache, response cache.
2. Create `open-sse/cache/cacheKeys.js`
   - Key builders: `modelLock(provider, connectionId, model)`, `apiKey(key)`, `responseCache(...)`.
3. Refactor existing in-memory mutex/locks (`src/sse/services/auth.js`) to use `DualCache`.
4. Create `open-sse/utils/requestContext.js`
   - Object carrying `requestId`, `model`, `provider`, `connectionId`, `deploymentId`, `retryCount`.
   - Pass context through executor, retry engine, and handlers.
5. Update response headers:
   - `x-9router-request-id`
   - `x-9router-provider`
   - `x-9router-model-id`
   - `x-9router-connection-id`
   - `x-9router-attempted-retries`

### Tests

- `tests/unit/dual-cache.test.js`
- `tests/unit/request-context.test.js`

### Acceptance Criteria

- [ ] Model locks use `DualCache` with TTL.
- [ ] Request context available in executor and retry engine.
- [ ] Response headers contain request metadata.

---

## Execution Order

Recommended sequential order:

1. Phase 1 — Unified Provider Interface
2. Phase 2 — HTTP Client Cache & Connection Pool
3. Phase 3 — Retry Engine v2
4. Phase 4 — Router Reliability Layer
5. Phase 5 — Streaming Normalization
6. Phase 6 — Error Taxonomy & Masking
7. Phase 7 — In-Memory Dual Cache & Request Context

Rationale: Phase 1 establishes the abstraction that Phases 2–7 build upon. Retry and connection improvements should precede routing/health decisions. Streaming normalization comes after connection/retry stability.

---

## Compact Review Process

After each phase:

1. Run the full unit test suite: `npx vitest run --config tests/vitest.config.js`
2. Update this plan: mark the phase checkbox `[x]` and add a brief `## Phase N — Compact` section below.
3. Summarize:
   - What changed
   - Tests added/passed
   - Known limitations or deferred items
   - Any deviations from plan

---

## Deferred (Future)

- Background health checks (out of scope)
- Batched spend/logging DB writes (out of scope)
- Redis-backed DualCache (out of scope — in-memory only)
- Full migration of specialized executors to `BaseProviderConfig` (soft migration — on-demand)
