# Plan: Fix Stream Truncation for Reasoning Models

## Problem Statement

When using opencode with 9router (via `@ai-sdk/openai-compatible`) to proxy reasoning models (kimi-k2.7, deepseek-v4, glm-5.2, minimax-m3, etc.), the stream delivers reasoning/thinking content but the actual text content is missing or the stream truncates unexpectedly. This happens across **multiple providers** behind 9router.

The user says: "thinking content then no content" — reasoning deltas arrive, but no text deltas follow.

---

## Root Cause Analysis

This is a **multi-layered problem** — not a single bug, but a combination of factors:

### 1. `max_tokens: 32000` is too low for reasoning models (PRIMARY CAUSE)

- **opencode always sends `max_tokens: 32000`** as default for models without `limit.output` configured
- Reasoning models can easily spend 20,000-32,000 tokens on reasoning alone, leaving nothing for content
- The upstream returns `finish_reason: "length"` with no content
- 9router forwards this correctly, but **opencode does NOT show an error for `finish_reason: "length"`** — the run just ends "normally"
- User sees: thinking content, then nothing, no error

**Why kimchi CLI doesn't have this**: The kimchi CLI uses the model's full `maxTokens` from the metadata API (64K-128K for kimi-k2.7), giving enough budget for both reasoning AND content.

### 2. 9router masks truncation as success

- 9router's passthrough flush **always synthesizes `[DONE]`** even when the stream ended abnormally (no `finish_reason` chunk)
- opencode doesn't detect truncation — the AI SDK's `flush` callback always emits a `finish` event with `finishReason: "other"` if no `finish_reason` arrived
- opencode treats `"other"` as a normal, successful completion
- Result: whether the stream ends cleanly (max_tokens exhaustion) or is truncated (network drop), opencode sees it as a successful completion with no content

### 3. `hasValuableContent` drops reasoning chunks for some providers

- `streamHelpers.js:42` only checks `delta.reasoning_content`, NOT `delta.reasoning` or `delta.reasoning_details`
- `extractReasoningText` in `reasoning.js:15-23` checks all three variants
- Providers that send `delta.reasoning` (e.g., vLLM-backed models via LiteLLM) have their reasoning chunks **silently dropped** in passthrough mode
- Confirmed by LiteLLM issue #20246: vLLM sends `reasoning`, LiteLLM's Delta model only recognizes `reasoning_content`

### 4. No Cloudflare 524 retry

- 9router's `DEFAULT_RETRY_CONFIG` only retries 429/502/503/504 — **524 is absent**
- The kimchi CLI explicitly retries 524 (`upstream-retry-patch.ts:14-21`)
- For Cloudflare-fronted gateways like `llm.kimchi.dev`, 524 timeouts during long reasoning phases are a known failure mode

### 5. No mid-stream retry

- 9router only retries **pre-stream** (response headers). Once streaming starts, any network error truncates the response with no retry.
- The kimchi CLI retries mid-stream errors (ECONNRESET, EPIPE, ERR_STREAM_PREMATURE_CLOSE, 524).

---

## Implementation Plan

### Fix A: `hasValuableContent` — recognize all reasoning field variants

**File**: `open-sse/utils/streamHelpers.js`

**What to change**: Lines 39-45 — add `delta.reasoning`, `delta.reasoning_text`, and `delta.reasoning_details` to the OpenAI format check, matching what `extractReasoningText` already handles.

**Code change**:
```js
// BEFORE:
return delta.content && delta.content !== "" ||
       delta.reasoning_content && delta.reasoning_content !== "" ||
       delta.tool_calls && delta.tool_calls.length > 0 ||
       chunk.choices[0].finish_reason ||
       delta.role;

// AFTER:
return delta.content && delta.content !== "" ||
       delta.reasoning_content && delta.reasoning_content !== "" ||
       delta.reasoning && delta.reasoning !== "" ||
       delta.reasoning_text && delta.reasoning_text !== "" ||
       (Array.isArray(delta.reasoning_details) && delta.reasoning_details.length > 0) ||
       delta.tool_calls && delta.tool_calls.length > 0 ||
       chunk.choices[0].finish_reason ||
       delta.role;
```

**Risk**: LOW. Only affects passthrough mode. Prevents dropping reasoning chunks from providers that use non-standard field names. Normal content/tool/finish chunks unaffected.

---

### Fix B: Synthesize `finish_reason` chunk on premature EOF in passthrough

**File**: `open-sse/utils/stream.js`

**What to change**:
1. Add `let passthroughFinishReasonSeen = false;` variable (near line 74, with the other tracking variables)
2. Set it to `true` at line 154 when `isFinishChunk` is truthy
3. In the passthrough flush (line 331-369), if `!passthroughFinishReasonSeen`, synthesize a terminal chunk before `[DONE]`:

**Code change** (new variable near line 74):
```js
let passthroughFinishReasonSeen = false;  // Track if upstream sent finish_reason
```

**Code change** (in passthrough transform, around line 154):
```js
const isFinishChunk = parsed.choices?.[0]?.finish_reason;
if (isFinishChunk) {
  passthroughFinishReasonSeen = true;
}
```

**Code change** (in passthrough flush, before `[DONE]` synthesis):
```js
// If the upstream never sent a finish_reason, synthesize one so the client
// gets a proper termination signal instead of defaulting to "other"
if (!passthroughFinishReasonSeen && !isGeminiFamily) {
  const finishOutput = "data: " + JSON.stringify({
    choices: [{ delta: {}, finish_reason: "stop" }]
  }) + "\n\n";
  reqLogger?.appendConvertedChunk?.(finishOutput);
  controller.enqueue(sharedEncoder.encode(finishOutput));
}
```

**Risk**: LOW. Only fires when upstream didn't send finish_reason. Gives the client a proper `finishReason: "stop"` instead of `"other"`. Doesn't affect normal completions.

---

### Fix C: Add 524 to retry config

**File**: `open-sse/config/runtimeConfig.js`

**What to change**: Line 67-72 — add `524` entry to `DEFAULT_RETRY_CONFIG`.

**Code change**:
```js
// BEFORE:
export const DEFAULT_RETRY_CONFIG = {
  429: { attempts: 0, delayMs: 0 },
  502: { attempts: 3, delayMs: 3000 },
  503: { attempts: 3, delayMs: 2000 },
  504: { attempts: 2, delayMs: 3000 }
};

// AFTER:
export const DEFAULT_RETRY_CONFIG = {
  429: { attempts: 0, delayMs: 0 },
  502: { attempts: 3, delayMs: 3000 },
  503: { attempts: 3, delayMs: 2000 },
  504: { attempts: 2, delayMs: 3000 },
  524: { attempts: 2, delayMs: 3000 }  // Cloudflare timeout during reasoning
};
```

**Risk**: LOW. Only affects pre-stream retries. 524 is a known failure mode for Cloudflare-fronted gateways. Same retry pattern as 502/504.

---

### Fix D: Add diagnostic logging for premature EOF

**File**: `open-sse/utils/stream.js` (passthrough flush)

**What to change**: In the passthrough flush (line 331-369), when `!passthroughFinishReasonSeen`, log a warning with diagnostics.

**Code change** (add to passthrough flush, before `[DONE]` synthesis):
```js
// Diagnostic logging: warn when stream ends without finish_reason
if (!passthroughFinishReasonSeen) {
  const reasoningChunks = accumulatedThinking.length;
  const contentChunks = accumulatedContent.length;
  console.warn(
    `[STREAM] WARNING: stream ended without finish_reason | ` +
    `provider=${provider} | model=${model} | ` +
    `contentLen=${contentChunks} | reasoningLen=${reasoningChunks} | ` +
    `bytes=${totalBytes}B | dur=${Date.now() - requestStartTime}ms`
  );
}
```

**Note**: `requestStartTime` may not be available in the TransformStream closure. May need to pass it in or use `Date.now()` at stream start. If unavailable, omit the duration.

**Risk**: LOW. Only fires on abnormal stream termination. Helps diagnose whether the issue is max_tokens exhaustion vs connection drops.

---

### Fix E: opencode config — increase `max_tokens` for reasoning models

**File**: `~/.config/opencode/opencode.json`

**What to change**: Add `"limit": { "output": 64000 }` to each reasoning model definition.

**Rationale**: The current default of 32000 is easily exhausted by reasoning alone on models like kimi-k2.7, deepseek-v4, and glm-5.2. 64000 gives enough budget for both reasoning and content.

**Models to update** (all reasoning models):
- `glm-5.2`
- `kimi-k2.6`
- `kimi-k2.7-code`
- `deepseek-v4-flash`
- `deepseek-v4-pro`
- `minimax-m3`
- `mimo-v2.5-pro`

**Example change** for each model:
```json
"glm-5.2": {
  "name": "glm-5.2",
  "limit": { "output": 64000 },
  "variants": { ... }
}
```

**Risk**: LOW. Some models may error if the limit is too high, but 64000 is a safe default (9router's own `DEFAULT_MAX_TOKENS` is 64000). If a specific model doesn't support it, it will return an error, and the user can adjust per-model.

**Alternative**: Set environment variable `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX=64000` globally instead of per-model. But per-model is more explicit and safer.

---

## Files to Modify

| # | File | Change | Priority |
|---|------|--------|----------|
| A | `open-sse/utils/streamHelpers.js` | Add reasoning field variants to `hasValuableContent` | HIGH |
| B | `open-sse/utils/stream.js` | Track finish_reason + synthesize on premature EOF | HIGH |
| C | `open-sse/config/runtimeConfig.js` | Add 524 to `DEFAULT_RETRY_CONFIG` | MEDIUM |
| D | `open-sse/utils/stream.js` | Add diagnostic logging for premature EOF | LOW |
| E | `~/.config/opencode/opencode.json` | Add `limit.output: 64000` to reasoning models | HIGH |

## Tests to Add/Run

- `tests/unit/openai-to-claude.test.js` — already has flush tests from previous session (keep)
- Build test: `npm run build`
- Unit tests: `npx vitest run tests/unit/openai-to-claude.test.js tests/unit/openai-to-claude-response-tools.test.js`

## Verification Steps (after deployment)

1. Restart 9router
2. Run a complex reasoning task with opencode → 9router → kimi-k2.7 (e.g., "explain quantum mechanics step by step")
3. Check if both reasoning and content are delivered
4. If still truncated, check 9router logs for the `[STREAM] WARNING` message from Fix D
5. If the warning shows `contentLen=0, reasoningLen=large`, the issue is max_tokens exhaustion — Fix E should resolve it
6. If the warning doesn't appear but content is still missing, check upstream logs for dropped chunks

## Notes

- Fix E (opencode config) is likely the **single most impactful change** — giving the model enough token budget for both reasoning and content
- Fixes A-D are 9router-side safety nets that prevent chunk dropping, mask truncation as success, and add retry for known failure modes
- The combination of all fixes should resolve the issue across all providers
