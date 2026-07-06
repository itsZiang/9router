# Core Engine Replacement Plan

## Goal
Replace the 4 core files in 9router's `open-sse` with OmniRoute's TypeScript versions converted to JavaScript, to fix NIM kimi-k2.6 stream drops.

## Key Files to Replace

| # | 9router File | Lines | OmniRoute Source | Lines | 
|---|-------------|-------|-------------------|-------|
| 1 | `utils/stream.js` | 534 | `utils/stream.ts` | 2726 |
| 2 | `utils/streamHelpers.js` | 124 | `utils/streamHelpers.ts` | 432 |
| 3 | `utils/proxyFetch.js` | 514 | `utils/proxyFetch.ts` | 666 |
| 4 | `utils/httpClientCache.js` | 209 | `utils/proxyDispatcher.ts` + `utils/proxyDispatcherCache.ts` | 610 |

## Dependency Files to Port

### Stream Pipeline Dependencies

| # | New File | Size | Description |
|---|---------|------|-------------|
| S1 | `utils/textualToolCall.js` | 112 lines | Parse textual tool call markers in stream content |
| S2 | `services/toolLatencyTracker.js` | 89 lines | Track tool invocation latency (self-contained) |
| S3 | `handlers/responseSanitizer.js` | 200 lines | Sanitize streaming chunks + OMIT marker |
| S4 | `utils/streamPayloadCollector.js` | 700 lines | SSE event collection + stream summary |
| S5 | `utils/passthroughTailProcessor.js` | 299 lines | Flush-time tail processing |

### Proxy Layer Dependencies

| # | New File | Size | Description |
|---|---------|------|-------------|
| P1 | `utils/proxyFamily.js` | 24 lines | IP family detection |
| P2 | `utils/proxyDispatcherCache.js` | 124 lines | RoundRobinDispatcher + cache |
| P3 | `utils/proxyDispatcher.js` | 486 lines | Dispatcher factory (depends on P1, P2) |

### Stubs for External Dependencies

| # | New File | Stubs |
|---|---------|-------|
| ST1 | `services/usageDb.js` | `trackPendingRequest`, `appendRequestLog` → no-ops |
| ST2 | `services/costCalculator.js` | `calculateCost` → returns 0 |
| ST3 | `services/omnirouteResponseMeta.js` | `buildOmniRouteSseMetadataComment` → returns `""` |

### Existing Files to Augment

| # | File | Missing Exports to Add |
|---|------|----------------------|
| A1 | `utils/streamHelpers.js` | `parseSSEDataPayload`, `createSSEDataLineNormalizer`, `createSSEEventPrefixBuffer`, `unwrapGeminiChunk` |
| A2 | `utils/responsesStreamHelpers.js` | `stringifyIdValue`, `normalizeResponsesSseIds`, `pushUniqueResponsesOutputItems`, `backfillResponsesCompletedOutput`, `stripResponsesLifecycleEcho` |

### Config Additions

| # | File | Key | Value |
|---|------|-----|-------|
| C1 | `config/runtimeConfig.js` | `STREAM_IDLE_TIMEOUT_MS` | `180000` |
| C2 | `config/runtimeConfig.js` | `FETCH_BODY_TIMEOUT_MS` | `180000` |

### New npm Packages

| Package | Reason |
|---------|--------|
| `fetch-socks` | SOCKS5 proxy support in proxyDispatcher |
| `socks` | Transitive dep of fetch-socks |

---

## Execution Phases

### Phase 1: Stream Dependencies (S1-S5)
Port all dependencies needed by stream.js

- [ ] S1: Create `utils/textualToolCall.js` — self-contained, no deps
- [ ] S2: Create `services/toolLatencyTracker.js` — self-contained, no deps
- [ ] S3: Create `handlers/responseSanitizer.js` — depends on `reasoningFields.js` (exists) + `finishReason.js` (new, minimal)
- [ ] S4: Create `utils/streamPayloadCollector.js` — depends on `translator/formats.js` (exists) + stub for `@/lib/logPayloads`
- [ ] S5: Create `utils/passthroughTailProcessor.js` — depends on `usageTracking.js`, `streamHelpers.js`, `responsesStreamHelpers.js`, `reasoningFields.js` (all exist or will be augmented)

### Phase 2: Augment Existing Helpers (A1-A2)
Add missing exports to existing files

- [ ] A1: Augment `utils/streamHelpers.js` — add `parseSSEDataPayload`, `createSSEDataLineNormalizer`, `createSSEEventPrefixBuffer`, `unwrapGeminiChunk`
- [ ] A2: Augment `utils/responsesStreamHelpers.js` — add `stringifyIdValue`, `normalizeResponsesSseIds`, `pushUniqueResponsesOutputItems`, `backfillResponsesCompletedOutput`, `stripResponsesLifecycleEcho`

### Phase 3: Port stream.js (Core File #1)
Convert OmniRoute's `stream.ts` → `utils/stream.js`

- [ ] Port `stream.ts` → `stream.js` (2726 lines)
- [ ] Strip TypeScript types, adapt imports to 9router paths
- [ ] Wire external stubs (ST1-ST3)
- [ ] Keep `createSSETransformStreamWithLogger`, `createPassthroughStreamWithLogger` API compatible

### Phase 4: Proxy Dependencies (P1-P3)
Port proxy dispatcher layer

- [ ] P1: Create `utils/proxyFamily.js` — trivial, `node:net` only
- [ ] P2: Create `utils/proxyDispatcherCache.js` — RoundRobinDispatcher + cache
- [ ] P3: Create `utils/proxyDispatcher.js` — depends on P1, P2, `fetch-socks` npm

### Phase 5: Port proxyFetch.js (Core Files #3-#4)
Replace proxyFetch.js + httpClientCache.js with OmniRoute's dispatcher-based version

- [ ] Port OmniRoute's `proxyFetch.ts` → `utils/proxyFetch.js` (666 lines)
- [ ] Adapt to use 9router's proxy config (env vars instead of feature flags)
- [ ] Skip TLS fingerprinting (`tlsClient.ts`) — not needed
- [ ] Skip proxy fallback (`proxyFallback.ts`) — not needed
- [ ] Skip `proxyFamilyResolve.ts` — not needed
- [ ] Keep `proxyAwareFetch`, `withFirstChunkTimeout`, `patchedFetch` API compatible

### Phase 6: Config + Stubs + npm (C1, C2, ST1-ST3)
Wire up remaining pieces

- [ ] Add `STREAM_IDLE_TIMEOUT_MS`, `FETCH_BODY_TIMEOUT_MS` to `runtimeConfig.js`
- [ ] Create stubs: `services/usageDb.js`, `services/costCalculator.js`, `services/omnirouteResponseMeta.js`
- [ ] Install npm: `fetch-socks`, `socks`

### Phase 7: Verify
- [ ] ESLint: 0 errors
- [ ] `npm run build`: EXIT=0
- [ ] No new test failures

---

## What Stays Unchanged

- `chatCore.js` — already wired to `stream.js` and `proxyFetch.js`, no API changes
- `streamingHandler.js` — heartbeat already wired, no changes
- `reasoningFields.js` — already ported from OmniRoute
- `sseHeartbeat.js` — already ported from OmniRoute
- `streamRecovery.js` — already ported from OmniRoute
- All executors, translators, providers — untouched

## Notes

- OmniRoute uses TypeScript, 9router uses JavaScript. All `.ts` → `.js` conversion strips:
  - Type annotations (`: Type`, `as Type`, `interface`, `type`)
  - `private`/`readonly` modifiers → `_` prefix convention
  - `import type` → remove entirely
  - `@` path aliases → relative paths
- After each phase, user will compact context to keep working memory clean
- File `utils/sessionManager.js` already exists in 9router but is a different module (Antigravity Cloud Code). OmniRoute's version lives at `services/sessionManager.js`. We'll create `services/sessionManager.js` from OmniRoute's version.