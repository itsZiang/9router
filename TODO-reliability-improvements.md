# 9Router Reliability Improvements — TODO

Prioritized list of improvements derived from a comprehensive comparison with LiteLLM 1.90.0. Only categories that directly impact core logic, network stability, and request reliability are included.

Full audit context: see `AUDIT-context-9router-vs-litellm.md`.

---

## CRITICAL (P0) — Active production incidents / resource leaks

### 1. [x] Wire client-disconnect signal in the chat path
- **Where:** `src/sse/handlers/chat.js` never passes `request.signal` to `handleChatCore` → `streamController` → fetch signal. Gemini-native route (`v1beta/.../route.js:285`) does it correctly.
- **Impact:** When a client disconnects but keeps TCP open, the upstream request is **not cancelled**. Provider quota/tokens continue to burn until the stall timeout (360s) fires. With many concurrent disconnects, this exhausts the undici pool (100) and provider rate limits simultaneously.
- **Fix:** In `chat.js`, add `request.signal?.addEventListener("abort", () => streamController.abort())` (or pass `request.signal` into `handleChatCore` and merge via `AbortSignal.any`). Mirror the pattern already used in the Gemini route.
- **Effort:** S (<1hr)

### 2. [x] Enable TCP keepalive on pooled undici agents
- **Where:** `open-sse/utils/httpClientCache.js:119-120, 146-147` — Agent options only set `bodyTimeout:0`, `headersTimeout:0`, `keepAliveTimeout:60s`. No `keepAlive`/`keepAliveInitialDelay` or socket-level `SO_KEEPALIVE`.
- **Impact:** Idle pooled connections are silently reaped by NAT gateways (AWS NAT: 350s) and load balancers. On reuse, the next request hits a dead socket → `ECONNRESET`/`UND_ERR_SOCKET`. Intermittent and hard to diagnose. LiteLLM explicitly engineers against this with `SO_KEEPALIVE`, `TCP_KEEPIDLE=60`, `TCP_KEEPINTVL=30`, `TCP_KEEPCNT=5`.
- **Fix:** Add `keepAlive: true, keepAliveInitialDelay: 30000` to Agent options, or pass a custom `connect` factory with socket `setKeepAlive(true, 30000)`.
- **Effort:** S

### 3. [x] Fix `poolLimitPerHost` dead config (no per-host connection cap)
- **Where:** `httpClientCache.js` — `HTTP_POOL_LIMIT_PER_HOST=10` is part of the cache key but **never passed to undici**. Only `connections` (=100) is used.
- **Impact:** A single hot upstream host (e.g. `api.openai.com`) can consume all 100 pool slots, starving requests to other providers. The config gives a false sense of a 10-connection-per-host cap.
- **Fix:** Either wire per-host limiting (undici doesn't have it natively — need a custom `Dispatcher`/`Agent` with `maxCachedRequests` or a per-origin semaphore), or remove the config entirely and document that the only cap is the global pool.
- **Effort:** S-M

---

## HIGH (P1) — Significant reliability gaps, real failure modes

### 4. [x] Add instant failover — skip backoff when alternatives available
- **Where:** `executors/base.js:194` — on retry, always `await sleep(plan.delayMs)`. No check for "are there other healthy accounts/URLs available?"
- **Impact:** A 429 on account A waits 1s+ before retrying account B, even though B is healthy. LiteLLM's `_time_to_sleep_before_retry` returns **0** when alternative deployments exist, making failover near-instant. Adds unnecessary latency on every failover.
- **Fix:** Before sleeping, check if `excludeConnectionIds` has room (other accounts available) or multiple `baseUrls` remain. If yes, skip the sleep (or cap at a tiny jitter). Reserve real backoff for single-account/single-URL scenarios.
- **Effort:** M

### 5. [x] Expand URL-fallback to 502/503/504, not just 429
- **Where:** `executors/base.js:87-89, 198-203` — `shouldRetry` advances URL index only for 429.
- **Impact:** If multiple `baseUrls` point to different mirrors/regions, a 502/503/504 on mirror A retries mirror A (same dead upstream) instead of advancing to mirror B. Wastes retry budget and time.
- **Fix:** Extend `shouldRetry` URL-advance condition to include 502/503/504/524 (the same set that RetryEngine retries). Keep 400/401/403/404 on the same URL (different key won't help a malformed request).
- **Effort:** S

### 6. [x] Add cooldown safety net — allow request when all accounts locked
- **Where:** `src/sse/handlers/chat.js:215-221` — when every account is locked, returns `unavailableResponse` (503).
- **Impact:** A transient burst of 429s can lock all accounts simultaneously. Even if one account's lock expires in 2 seconds, the user gets a hard 503 until then. LiteLLM bypasses cooldown when ALL deployments are down (best-effort with warning).
- **Fix:** When `excludeConnectionIds` covers all accounts, find the account with the earliest `rateLimitedUntil` and allow the request anyway (with a `[FALLBACK-EMERGENCY]` log). Trades a likely-429 for a chance of success vs. a guaranteed 503.
- **Effort:** M

### 7. [x] Add stream repetition/loop detection
- **Where:** Streaming pipeline (`streamHandler.js`, `createNormalizedStream.js`) — no check for repeated identical chunks.
- **Impact:** A misbehaving provider can emit the same chunk in an infinite loop. The stall timer never fires (bytes are arriving), so the stream runs until max duration (which 9Router doesn't have — see #11) or the client gives up. Burns tokens and connection slots.
- **Fix:** Track last chunk content hash in `createNormalizedStream.transform`. If N consecutive identical chunks (LiteLLM uses 100), abort the stream with a retriable error. Skip chunks with no content (usage/ping).
- **Effort:** M

### 8. [x] Shield upstream cleanup from cancellation
- **Where:** `streamHandler.js:144-145, 180-181` — `reader.cancel()` + `writer.abort()` called directly, no shielding from a concurrent abort.
- **Impact:** If the abort signal fires *during* cleanup, `reader.cancel()` can be interrupted, leaving the upstream connection leaked in the undici pool. LiteLLM uses `anyio.CancelScope(shield=True)` to guarantee `aclose()` completes.
- **Fix:** Wrap cleanup in a `Promise.race` with a timeout, or use a flag that ignores subsequent aborts once cleanup has started. Ensure `reader.cancel()` resolves before returning.
- **Effort:** S

---

## MEDIUM (P2) — Edge cases, accuracy, dead code

### 9. [ ] Add partial usage recovery on mid-stream failure
- **Where:** `streamingHandler.js` `onStreamComplete` — on mid-stream error, usage tracking fires with null content.
- **Impact:** Billing/usage stats undercount for requests that consumed tokens upstream but errored before completion. LiteLLM assembles partial usage from seen chunks via `stream_chunk_builder`.
- **Fix:** In the transform stream, accumulate `usage` from chunks as they arrive. On `onStreamError`, pass the accumulated partial usage to `trackPendingRequest`/`saveUsageStats`.
- **Effort:** M

### 10. [ ] Lower connect timeout from 60s to 10-15s
- **Where:** `executors/base.js:160-163` — `FETCH_CONNECT_TIMEOUT_MS=60000`.
- **Impact:** A dead/unreachable upstream holds a pool slot and the request for a full minute before aborting. LiteLLM uses 5s. During an outage, this compounds — 100 pool slots × 60s = catastrophic stall.
- **Fix:** Lower to 10-15s default. Keep it env-overridable for slow-proxy environments.
- **Effort:** S

### 11. [ ] Add max stream wall-clock duration
- **Where:** No equivalent of LiteLLM's `LITELLM_MAX_STREAMING_DURATION_SECONDS`.
- **Impact:** A stream that keeps trickling bytes (but never completes) runs forever — stall timer keeps re-arming on each byte. Connection slot and provider quota consumed indefinitely.
- **Fix:** Add `STREAM_MAX_DURATION_MS` (env, default e.g. 600s). Track `_streamCreatedTime`; check elapsed on each chunk in `upstreamTap.transform`; abort if exceeded.
- **Effort:** S

### 12. [ ] Remove dead first-chunk timeout code in proxyFetch
- **Where:** `proxyFetch.js:247-305` — clean implementation exported but never invoked; `maybeFirstChunkTimeout` is a no-op.
- **Impact:** Maintenance hazard — future devs may think first-chunk timeout is handled here, but it's actually in `streamHandler.js`. Two implementations drift.
- **Fix:** Delete `withFirstChunkTimeout`/`maybeFirstChunkTimeout` from `proxyFetch.js`, or consolidate into one location.
- **Effort:** S

---

## Summary Table

| # | Issue | Priority | Category | Effort |
|---|---|---|---|---|
| 1 | Client-disconnect signal not wired | P0 | Core logic / cancel | S |
| 2 | No TCP keepalive | P0 | Network stability | S |
| 3 | poolLimitPerHost dead config | P0 | Network stability | S-M |
| 4 | No instant failover | P1 | Reliability / retry | M |
| 5 | URL-fallback only on 429 | P1 | Reliability / retry | S |
| 6 | No cooldown safety net | P1 | Reliability / failover | M |
| 7 | No stream loop detection | P1 | Reliability / streaming | M |
| 8 | Cleanup not shielded | P1 | Network stability | S |
| 9 | No partial usage recovery | P2 | Accuracy | M |
| 10 | Connect timeout 60s | P2 | Network stability | S |
| 11 | No max stream duration | P2 | Reliability / streaming | S |
| 12 | Dead first-chunk code | P2 | Tech debt | S |

**Effort:** S = <1hr, M = 2-4hr

---

## Status Tracking

- **Not started:** P2 items (9,10,11,12)
- **Order of attack:** P0 (1,2,3) → P1 (4,5,6,7,8) → P2 (9,10,11,12)
- **Done:** P0 #1-#3, P1 #4-#8
