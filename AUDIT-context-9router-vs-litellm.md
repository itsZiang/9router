# Audit Context — 9Router vs LiteLLM 1.90.0 Network Reliability Comparison

This file preserves the key findings from a comprehensive comparison between 9Router and LiteLLM 1.90.0. It is meant as context for future work sessions (especially after context compaction) so that the agent can continue without re-exploring both codebases.

The actionable TODO list is in `TODO-reliability-improvements.md`.

---

## 1. Codebase Locations

- **9Router:** `/home/letruonggiang/work/9router` — Node.js gateway. Key dirs: `open-sse/` (core), `src/sse/handlers/` (route handlers), `open-sse/executors/` (provider executors), `open-sse/utils/` (infra), `open-sse/streaming/` (stream pipeline), `open-sse/config/` (runtime config), `open-sse/providers/` (provider configs).
- **LiteLLM:** `/home/letruonggiang/work/litellm-1.90.0` — Python gateway. Key files: `litellm/router.py`, `litellm/litellm_core_utils/streaming_handler.py`, `litellm/llms/custom_httpx/http_handler.py`, `litellm/llms/custom_httpx/aiohttp_transport.py`, `litellm/litellm_core_utils/exception_mapping_utils.py`, `litellm/exceptions.py`, `litellm/constants.py`, `litellm/utils.py`.

---

## 2. Prior Completed Work (Phases 1-5)

Before this audit, the following phases were completed (see `PLAN-core-upgrade.md` and `ADR-core-upgrade.md`):

- **Phase 1** — Unified Provider Interface: `BaseProviderConfig.js` + `DefaultProviderConfig.js`; `base.js` delegates to provider config when present. Soft migration — legacy executors untouched.
- **Phase 2** — HTTP Client Cache: `HttpClientCache` (pooled undici agents, TTL=10min, maxSize=20, LRU-by-expiry); `proxyFetch.js` uses cache; `Connection: close` removed from proxied fetches.
- **Phase 3** — Retry Engine v2: `RetryEngine` (stateless, per-status policy, `fixed`/`exponential`/`exponential_jitter`, Retry-After/x-ratelimit-reset parsing); `base.js` consumes body before retry (`response.body?.cancel?.()`); 429 default = `exponential_jitter` 3 attempts 1s base.
- **Phase 5** — Streaming Normalization: `BaseResponseIterator` + `OpenAIResponseIterator` + `createNormalizedStream`; format-specific terminal bytes on abort; premature EOF synthesis; `onStreamComplete` guarded to fire once; `onStreamError` fallback for mid-stream errors; first-chunk timeout in `streamHandler.js`.

### Deferred phases:
- Phase 4 (Router Reliability / Deployment Health + TPM/RPM) — skipped.
- Phase 6 (Error Taxonomy & Masking) — deferred (non-core).
- Phase 7 (Dual Cache & Request Context) — deferred (non-core).

---

## 3. Architecture Comparison Summary

### HTTP Client
- **LiteLLM:** `httpx` + custom `aiohttp` transport. Pool: limit=1000, per-host=500, keepalive=120s, DNS TTL=300s. Client cache TTL=3600s. **TCP SO_KEEPALIVE** opt-in (TCP_KEEPIDLE=60, TCP_KEEPINTVL=30, TCP_KEEPCNT=5) — explicitly engineered against NAT/LB idle-reaping. SSL tuned (TLS 1.2 min, TLS 1.3 cipher pref, ECDH curve override). IPv4 forcing. `atexit` cleanup. `__del__` cleanup.
- **9Router:** undici `fetch` (globally patched via `proxyFetch.js`). `HttpClientCache`: connections=100, keepalive=60s, TTL=10min, maxSize=20, LRU. No TCP keepalive. No SSL tuning. No IPv4 forcing. `poolLimitPerHost=10` is **dead config** (part of cache key but never passed to undici Agent).

### Timeout Strategy
- **LiteLLM:** connect=5s, read/write=600s. No first-chunk timeout (TTFT tracked for metrics only). `LITELLM_MAX_STREAMING_DURATION_SECONDS` (opt-in) for max stream wall-clock. Separate `stream_timeout` knob. Streaming error body read timeout=5s.
- **9Router:** connect=60s, bodyTimeout=0/headersTimeout=0 on agent (managed externally). First-chunk timeout=200s (in `streamHandler.js`, armed at pipe start, cleared on first byte). Stall timeout=360s (re-armed per raw upstream byte, per-provider overridable). No max stream duration.

### Retry Logic
- **LiteLLM:** 3+ layers (provider-translation retry → wrapper retry → router retry). Retries 408/409/429/≥500. Exponential backoff 0.5s×2^attempt, cap 8s, +0.75s jitter. Retry-After parsed (seconds + HTTP-date), capped 60s. **Instant failover** (sleep=0 when healthy deployments exist). `RetryPolicy` per exception type. Mid-stream 429 → `MidStreamFallbackError` with `is_pre_first_chunk` flag (router can fallback pre-first-chunk). Body drained before retry via `_safe_aread_response` (5s timeout). 401/403 retried only if >1 deployment.
- **9Router:** 2 layers (in-request RetryEngine → cross-account failover). Retries 429/502/503/504/524. Per-status config (fixed or exponential_jitter), cap 5min. Retry-After + x-ratelimit-reset-after + x-ratelimit-reset parsed, capped 5min. **No instant failover** — always sleeps full backoff. URL-fallback only on 429 (not 5xx). Token-refresh retry (3 attempts) on 401/403. Codex executor peeks first 4KB for overloaded signal. Body consumed before retry (`response.body?.cancel?.()`).

### Streaming Reliability
- **LiteLLM:** `CustomStreamWrapper`. No stall detection (read timeout only). **Repetition/loop detection** (`REPEATED_STREAMING_CHUNK_LIMIT=100` identical chunks → error). Max stream duration (opt-in). Upstream drop → swallow `ClientPayloadError`/`Connection closed`/`TransferEncodingError` (graceful end-of-stream); `finally` releases pool slot. `aclose()` shielded from cancellation (`anyio.CancelScope(shield=True)`). **Partial usage recovery** on mid-stream failure via `stream_chunk_builder`. `MidStreamFallbackError` for pre-first-chunk fallback. `[DONE]` on completion (skipped for Google GenAI). aiohttp reads 16KB chunks.
- **9Router:** Pipeline: `upstreamTap` (byte-counter + stall watchdog) → `transformStream` (SSE translate/passthrough or normalized iterator) → `createDisconnectAwareStream` (disconnect-aware reader). Stall detection (360s, re-armed per raw byte — measures raw upstream bytes, NOT transform output, to handle reasoning models). First-chunk timeout (200s). Network-close allowlist (`ECONNRESET`, `ETIMEDOUT`, `UND_ERR_SOCKET`, etc.) → emit terminal bytes, close gracefully. Format-specific terminal bytes: OpenAI → synthetic finish + `[DONE]`; Claude → `message_stop`; Gemini → null; Responses → `response.failed` + `[DONE]`. Premature EOF → synthetic `finish_reason:"stop"`. Null-body guard. `onStreamComplete` guarded (fires once). **No repetition detection. No max duration. No partial usage recovery. Cleanup not shielded.**

### Error Handling
- **LiteLLM:** 15+ exception types subclassing OpenAI SDK (`AuthenticationError`, `RateLimitError`, `InternalServerError`, `MidStreamFallbackError`, `ContextWindowExceededError`, `ContentPolicyViolationError`, etc.). Central `exception_type()` mapper with per-provider branches. String-based classification (matches "rate limit", "context window exceeded", "content policy violation" in error text). `RateLimitErrorCategory` (vendor vs litellm) + `RateLimitType` (requests/tokens/concurrent/budget). `MaskedHTTPStatusError` strips secrets. Header injection protection (headers NOT auto-populated from response). aiohttp → httpx exception mapping.
- **9Router:** OpenAI-compatible status→type mapping (`errorConfig.js`). `resetsAtMs` for provider cooldowns. Three-tier upstream error parsing (provider-config `parseError` → executor `parseError` → default JSON). `ERROR_RULES` text patterns (rate limit, quota, capacity, overloaded, no credentials). `QUOTA_POOL_PATTERNS` triggers auto key replacement. Cooldown caps (30min for provider-reported, 5min for backoff). No error masking (Phase 6 deferred).

### Failover / Fallback / Cooldown
- **LiteLLM:** `CooldownCache` (Redis+in-memory, TTL=cooldown_time). Failure thresholds (default 3 fails / 50% rate, min 5 requests). **Cooldown safety net**: if ALL deployments cooled down via health-check, bypass cooldown. Fallbacks: order-based, weighted intra-group, context-window, content-policy, regular, default. Bounded by `max_fallbacks=5`. Health-check routing (`DeploymentHealthCache`). Single-deployment protection (`SINGLE_DEPLOYMENT_TRAFFIC_FAILURE_THRESHOLD=1000`). `allowed_fails_policy` per deployment.
- **9Router:** Per-model locks (`modelLock_${model}`) on connection records with computed cooldowns. URL fallback (429 only). Cross-account failover (exclude set). Model combos (fallback/fusion). **No cooldown safety net** — all locked → 503. No health checks. No max fallbacks. Auto key replacement from pool (`QUOTA_POOL_PATTERNS`). Provider-specific: Cloudflare daily-quota (next 00:10 UTC), Siliconflow 503 (15min all-accounts). Optimistic recovery on success (`clearAccountError`).

### Abort / Cancel Handling
- **LiteLLM:** `Request.is_disconnected()` polled in proxy. `CancelledError`/`GeneratorExit` caught in `async_data_generator` — releases parallel-request limiter, tags `client_disconnected=True`, error_code=499. Shielded `aclose()`. `_release_max_parallel_requests_on_disconnect`. Budget reservation cleanup on cancel.
- **9Router:** `streamController` with `handleDisconnect`/`handleError`/`abort` + 500ms delayed abort. Upstream abort propagation via `streamController.signal` merged with `AbortSignal.any`. **Critical gap: `src/sse/handlers/chat.js` does NOT wire `request.signal` to `streamController`** — client disconnects not detected until Response stream cancelled by Next.js. Gemini route does it correctly. `reader.cancel()` + `writer.abort()` not shielded.

### Resilience Features
- **LiteLLM:** **Full proactive rate limiting**: parallel request limiter (max_parallel_requests, RPM, TPM per API key/team/model), dynamic rate limiter, model rate limit, batch rate limiter, budget limiter, max iterations limiter. **Request scheduler** (priority queue, 30ms polling). Pending request tracking. Redis circuit breaker (5 fails → 60s recovery). Response caching (in-memory + Redis, 5s default). Logging worker resilience (bounded queues, 50% clear on overflow). `MAX_CALLBACKS=100`.
- **9Router:** **No proactive rate limiting or concurrency control** — observability only. `trackPendingRequest` with 60s safety timer (auto-zeroes stuck counters, floor at 0). Pending tracking is observability-only (dashboard). No request scheduler. No response cache (Phase 7 deferred). All throttling is reactive (cooldowns after errors).

### SSE Parsing
- **LiteLLM:** httpx/aiohttp `iter_lines()` reassembles partial TCP segments into lines. `BaseModelResponseIterator` handles `data:` prefix stripping, `[DONE]` detection, `JSONDecodeError` → skip (returns None). `UnicodeDecodeError` **NOT caught** (fragility). `_strip_sse_data_from_chunk` handles `data: ` (OpenAI) and `data:` (SageMaker). Provider-specific chunk parsers. Cached stream replay pacing (0.02s).
- **9Router:** Two parallel parsers: (A) Legacy `createSSEStream` (`utils/stream.js`) — `TextDecoder({stream:true})` for multi-byte UTF-8, line buffering, `parseSSELine` fast-path char-code check, malformed JSON → skip, passthrough sanitization (injects missing `object`/`created`, strips Azure `prompt_filter_results`, fixes invalid IDs, silently skips non-JSON data lines). (B) Iterator-based `createNormalizedStream` + `OpenAIResponseIterator` — `parseChunk` decode + buffer, `_parseBuffer` splits on `\n`, `_parseLine` skips `event:`/`id:`/`:`, `[DONE]` detection, `JSON.parse` try/catch → null. `normalizeOpenAIChunk` fills defaults. Parse errors caught and skipped (never kill stream). Flush wrapped in try/catch with best-effort `[DONE]`. **More robust than LiteLLM** (UTF-8 stream handling, partial-chunk resilience).

---

## 4. Scorecard

| Dimension | LiteLLM | 9Router | Winner |
|---|---|---|---|
| Connection pooling tuning | 9/10 | 6/10 | LiteLLM |
| Timeout strategy | 7/10 | 8/10 | **9Router** (first-chunk + stall) |
| Retry logic | 9/10 | 7/10 | LiteLLM |
| Streaming reliability | 8/10 | 8/10 | Tie (different strengths) |
| Error classification | 9/10 | 7/10 | LiteLLM |
| Failover/fallback | 9/10 | 7/10 | LiteLLM |
| Abort/cancel handling | 9/10 | 4/10 | **LiteLLM** (9Router gap is critical) |
| Resilience features | 9/10 | 4/10 | LiteLLM |
| SSE parsing robustness | 7/10 | 8/10 | **9Router** (better UTF-8 handling) |
| Request context | 8/10 | 7/10 | LiteLLM |

**Bottom line:** 9Router's streaming pipeline (stall detection, terminal bytes, premature EOF, SSE parsing) is in some ways **more sophisticated** than LiteLLM's. But LiteLLM wins decisively on **proactive resilience** (rate limiting, concurrency control, health checks), **failover sophistication** (instant failover, cooldown safety net, mid-stream fallback), and **cancel handling** (the 9Router chat-path disconnect gap is a real problem).

---

## 5. Key File References (9Router)

| File | Role |
|---|---|
| `src/sse/handlers/chat.js` | Main chat route handler; cross-account failover loop; model combo routing. **Gap: `request.signal` not wired.** |
| `open-sse/handlers/chatCore.js` | Core handler; provider-config aware; retry metadata; token-refresh retry; `streamController` creation. |
| `open-sse/handlers/chatCore/streamingHandler.js` | Streaming response handler; `buildTransformStream`; `onStreamComplete` guard; `onStreamError`; `buildAbortedTerminalBytes`; retry header emission. |
| `open-sse/handlers/chatCore/nonStreamingHandler.js` | Non-streaming response handler; retry header emission. |
| `open-sse/utils/streamHandler.js` | Stream piping; `createStreamController`; `pipeWithDisconnect`; `upstreamTap` (byte-counter + stall watchdog); first-chunk timeout; stall timeout; `createDisconnectAwareStream` (network-close allowlist, terminal emission); null-body guard; `onStreamError`. |
| `open-sse/utils/retryEngine.js` | `RetryEngine` class; per-status policy; backoff strategies; Retry-After/x-ratelimit-reset parsing; custom delay/veto hook; `NON_RETRYABLE_STATUSES`. |
| `open-sse/executors/base.js` | Base executor; RetryEngine integration; `response.body?.cancel?.()` before retry; URL fallback (429 only); connect timeout (60s); network exception → 502. |
| `open-sse/executors/default.js` | Default executor; delegates to `DefaultProviderConfig`. |
| `open-sse/providers/DefaultProviderConfig.js` | Provider config; `getResponseIterator()` → `OpenAIResponseIterator`; `buildUrl()` (fallback: providerSpecificData.baseUrl → apiBase → config.baseUrl → OPENAI_COMPAT_BASE). |
| `open-sse/providers/BaseProviderConfig.js` | Abstract provider config interface. |
| `open-sse/utils/httpClientCache.js` | Pooled undici agent cache; TTL=10min; maxSize=20; LRU-by-expiry; `_closeAgent()` on eviction. **Gap: no TCP keepalive; poolLimitPerHost dead.** |
| `open-sse/utils/proxyFetch.js` | Fetch layer using `HttpClientCache`; env-proxy; MITM DNS bypass; proxy retry; **`withFirstChunkTimeout` dead code** (maybeFirstChunkTimeout is passthrough). |
| `open-sse/streaming/BaseResponseIterator.js` | Abstract streaming iterator interface (`parseChunk`/`flush`). |
| `open-sse/streaming/OpenAIResponseIterator.js` | OpenAI SSE parser/normalizer. |
| `open-sse/streaming/createNormalizedStream.js` | Normalized stream transform; try/catch in flush + parseChunk; break on doneSent; premature EOF synthesis. |
| `open-sse/utils/stream.js` | Legacy `createSSEStream`; passthrough sanitization; Responses-API framing; `streamDoneSent` guard. |
| `open-sse/utils/streamHelpers.js` | `parseSSELine`; `hasValuableContent`. |
| `open-sse/config/runtimeConfig.js` | Runtime config; `HTTP_POOL_LIMIT=100`, `HTTP_POOL_LIMIT_PER_HOST=10`, `HTTP_KEEPALIVE_TIMEOUT_MS=60s`, `HTTP_DNS_TTL_MS`, `HTTP_CLIENT_CACHE_TTL_MS=10min`; `STREAM_FIRST_CHUNK_TIMEOUT_MS=200s`, `STREAM_STALL_TIMEOUT_MS=360s`; `DEFAULT_RETRY_CONFIG`. |
| `open-sse/config/errorConfig.js` | `ERROR_TYPES`; `ERROR_RULES` (text + status); `QUOTA_POOL_PATTERNS`; cooldown caps; `BACKOFF_CONFIG`. |
| `open-sse/utils/error.js` | `parseUpstreamError` (three-tier); `buildErrorBody`; `errorResponse`; `writeStreamError`; `createErrorResult`; `unavailableResponse`. |
| `open-sse/utils/auth.js` | Account selection (`fill-first`/`round-robin`); `markAccountUnavailable`; `clearAccountError`; auto-replace from pool; provider mutexes; provider-specific cooldowns. |
| `open-sse/utils/usageRepo.js` | `trackPendingRequest` (60s safety timer, floor at 0); `getActiveRequests`; daily aggregation; cost calculation. |
| `src/sse/handlers/v1beta/models/[...path]/route.js` | Gemini-native route; **correctly wires `request.signal`** (reference pattern for fix #1). |

---

## 6. Key File References (LiteLLM — for pattern reference)

| File | Role |
|---|---|
| `litellm/llms/custom_httpx/http_handler.py` | `AsyncHTTPHandler`/`HTTPHandler`; client cache (TTL=3600s); `_create_async_transport` (aiohttp); SSL config; `force_ipv4`; `_safe_aread_response` (5s timeout); `MaskedHTTPStatusError`; `track_llm_api_timing`. |
| `litellm/llms/custom_httpx/aiohttp_transport.py` | `LiteLLMAiohttpTransport`; pool config (limit=1000, per-host=500, keepalive=120s, DNS TTL=300s); `SO_KEEPALIVE` socket factory; `AIOHTTP_EXC_MAP`; `AiohttpResponseStream` (16KB chunks, `finally` releases pool slot, swallows `ClientPayloadError`/`Connection closed`). |
| `litellm/litellm_core_utils/streaming_handler.py` | `CustomStreamWrapper`; `raise_on_model_repetition` (100 identical chunks); `_check_max_streaming_duration`; `_handle_stream_fallback_error` (`MidStreamFallbackError` with `is_pre_first_chunk`); `_record_partial_usage_for_failure`; shielded `aclose()`. |
| `litellm/router.py` | `async_function_with_retries`; `should_retry_this_error`; `_time_to_sleep_before_retry` (instant failover: sleep=0 when healthy deployments exist); `deployment_callback_on_failure` (cooldown with `Retry-After`); `_filter_cooldown_deployments` (safety net bypass); fallback logic (order-based, weighted, context-window, content-policy, regular, default); `max_fallbacks=5`. |
| `litellm/utils.py` | `_should_retry` (408/409/429/≥500); `_calculate_retry_after` (exponential 0.5s×2^attempt, cap 8s, jitter 0.75s; Retry-After capped 60s); `_get_wrapper_num_retries`; wrapper retry (non-router). |
| `litellm/exceptions.py` | 15+ exception types; `RateLimitErrorCategory`; `RateLimitType`; `MidStreamFallbackError` (`generated_content`, `is_pre_first_chunk`); `LITELLM_EXCEPTION_TYPES`. |
| `litellm/litellm_core_utils/exception_mapping_utils.py` | `exception_type()` central mapper; `ExceptionCheckers` (string-based classification); `_get_response_headers`. |
| `litellm/constants.py` | All constants: `DEFAULT_MAX_RETRIES=2`, `INITIAL_RETRY_DELAY=0.5`, `MAX_RETRY_DELAY=8.0`, `JITTER=0.75`, `AIOHTTP_CONNECTOR_LIMIT=1000`, `DEFAULT_COOLDOWN_TIME_SECONDS=5`, `REPEATED_STREAMING_CHUNK_LIMIT=100`, `LITELLM_MAX_STREAMING_DURATION_SECONDS`. |
| `litellm/router_utils/cooldown_cache.py` | `CooldownCache` (Redis+in-memory, TTL=cooldown_time); `get_min_cooldown`. |
| `litellm/router_utils/get_retry_from_policy.py` | `RetryPolicy` (per-exception-type retry counts). |
| `litellm/llms/base_llm/base_model_iterator.py` | `BaseModelResponseIterator` (`__next__`/`__anext__`, `_handle_string_chunk`, `_string_to_dict_parser`, `aclose()`). |
| `litellm/scheduler.py` | `Scheduler` (priority queue, 30ms polling, `DualCache`-backed). |
| `litellm/proxy/hooks/parallel_request_limiter.py` | Max parallel requests, RPM, TPM per API key/team/model. |

---

## 7. What to Do Next

See `TODO-reliability-improvements.md` for the prioritized, actionable list. The recommended attack order:

1. **P0 items (1, 2, 3)** — fix client-disconnect signal, TCP keepalive, dead poolLimitPerHost config.
2. **P1 items (4, 5, 6, 7, 8)** — instant failover, 5xx URL-fallback, cooldown safety net, stream loop detection, shielded cleanup.
3. **P2 items (9, 10, 11, 12)** — partial usage recovery, lower connect timeout, max stream duration, dead code removal.

After completing P0-P1, re-audit the streaming pipeline for edge cases introduced by the changes.

---

## 8. Testing Context

- Tests run with Vitest from repo root: `npx vitest run <filter>`.
- Existing targeted test files (from Phases 1-5):
  - `tests/unit/provider-config-default.test.js` (24 tests)
  - `tests/unit/executor-soft-migration.test.js` (7 tests)
  - `tests/unit/http-client-cache.test.js` (12 tests)
  - `tests/unit/proxyFetch-first-chunk-timeout.test.js` (6 tests)
  - `tests/unit/retry-engine.test.js` (19 tests)
  - `tests/unit/base-executor-retry.test.js`
  - `tests/unit/stream-iterator-openai.test.js` (7 tests)
  - `tests/unit/stream-first-chunk-timeout.test.js` (2 tests)
- Full `unit/` suite has pre-existing failures unrelated to Phases 1-5 (e.g., `embeddingsCore.test.js` mocks `proxyFetch` default export; `claude-header-forwarding.test.js` expects disabled got-scraping path; `executor-const-guard.test.js` expects `429 attempts = 6` vs registry value `3`).
