# Plan: Mid-stream fallback + diagnostics (chuẩn hóa theo litellm)

Mục tiêu: khắc phục "chỉ reasoning, content rỗng" với NIM (và provider tương tự)
khi gọi qua 9router. Root cause: `streamHandler.js` mask lỗi mid-stream thành
finish sạch (emitTerminal + close) → downstream thấy finish bình thường → content
mất vĩnh viễn, không retry. litellm làm ngược lại (`MidStreamFallbackError` →
`Router.stream_with_fallbacks` re-prompt nối tiếp, router.py:1945-2051).

Phạm vi duyệt: **Phase 0 (diagnostic) + Phase 2A (re-prompt nội bộ, opt-in)**.
Phase 1/3/4 (normalize passthrough / fresh-client retry / stall tune) để sau.

An toàn: Phase 2A **opt-in qua env `MID_STREAM_FALLBACK_ATTEMPTS` (default 0 = OFF)**.
Khi OFF, behavior **giữ nguyên 100%** (path hiện tại không đổi). Bật trên
diepcabenbi để test.

---

## Edit 1 — `open-sse/config/runtimeConfig.js`

Thêm config opt-in. Chèn sau dòng `export const DEFAULT_MIN_TOKENS = 32000;` (line 57):

```js
// Mid-stream fallback: when an upstream stream errors mid-flight (ECONNRESET,
// EPIPE, stall timeout, …) AND the client is still connected, transparently
// re-execute the request and continue streaming. Mirrors litellm's
// MidStreamFallbackError → Router.stream_with_fallbacks (router.py:1945).
// 0 = OFF (current behavior: graceful-close + synthetic [DONE], content lost).
// N = allow N retry attempts after the original. Env: MID_STREAM_FALLBACK_ATTEMPTS.
export const MID_STREAM_FALLBACK_ATTEMPTS = (() => {
  const raw = process.env.MID_STREAM_FALLBACK_ATTEMPTS;
  if (raw == null || raw === "") return 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
})();
```

---

## Edit 2 — `open-sse/utils/stream.js` (stateRef + Phase 0 accumulation fix)

### 2a. `createSSEStream` options: thêm `stateRef = null` vào destructuring (khoảng line 39-52)

```js
export function createSSEStream(options = {}) {
  const {
    mode = STREAM_MODE.TRANSLATE,
    targetFormat,
    sourceFormat,
    provider = null,
    reqLogger = null,
    toolNameMap = null,
    model = null,
    connectionId = null,
    body = null,
    onStreamComplete = null,
    apiKey = null,
    stateRef = null          // ← THÊM: shared object để fallback đọc accumulated content
  } = options;
```

### 2b. Phase 0 fix — passthrough accumulation (lines 138-148)

BEFORE:
```js
const delta = parsed.choices?.[0]?.delta;
const content = delta?.content;
const reasoning = delta?.reasoning_content;
if (content && typeof content === "string") {
  totalContentLength += content.length;
  accumulatedContent += content;
}
if (reasoning && typeof reasoning === "string") {
  totalContentLength += reasoning.length;
  accumulatedThinking += reasoning;
}
```

AFTER (đọc cả `reasoning` + `reasoning_details` + sync stateRef):
```js
const delta = parsed.choices?.[0]?.delta;
const content = delta?.content;
if (content && typeof content === "string") {
  totalContentLength += content.length;
  accumulatedContent += content;
}
// Phase 0: đọc mọi biến thể reasoning (reasoning_content / reasoning / reasoning_text / reasoning_details)
const r1 = delta?.reasoning_content;
const r2 = delta?.reasoning;
const r3 = delta?.reasoning_text;
const r4 = Array.isArray(delta?.reasoning_details)
  ? delta.reasoning_details.map(d => (typeof d === "string" ? d : d?.text || d?.content || "")).join("")
  : "";
const reasoning = r1 || r2 || r3 || r4;
if (reasoning && typeof reasoning === "string") {
  totalContentLength += reasoning.length;
  accumulatedThinking += reasoning;
}
if (stateRef) {
  stateRef.accumulatedContent = accumulatedContent;
  stateRef.accumulatedThinking = accumulatedThinking;
}
```

### 2c. Phase 0 fix — translate-mode accumulation (lines 248-252)

BEFORE:
```js
// OpenAI format - reasoning
if (parsed.choices?.[0]?.delta?.reasoning_content) {
  totalContentLength += parsed.choices[0].delta.reasoning_content.length;
  accumulatedThinking += parsed.choices[0].delta.reasoning_content;
}
```

AFTER (thêm `reasoning` + sync stateRef):
```js
// OpenAI format - reasoning (cả reasoning_content và reasoning)
{
  const d = parsed.choices?.[0]?.delta;
  const rc = d?.reasoning_content || d?.reasoning;
  if (rc) {
    totalContentLength += rc.length;
    accumulatedThinking += rc;
  }
}
if (stateRef) {
  stateRef.accumulatedContent = accumulatedContent;
  stateRef.accumulatedThinking = accumulatedThinking;
}
```

### 2d. Sync `finishChunkSeen` vào stateRef (line 156)

BEFORE:
```js
const isFinishChunk = parsed.choices?.[0]?.finish_reason;
if (isFinishChunk) finishChunkSeen = true;
```

AFTER:
```js
const isFinishChunk = parsed.choices?.[0]?.finish_reason;
if (isFinishChunk) {
  finishChunkSeen = true;
  if (stateRef) stateRef.finishChunkSeen = true;
}
```

### 2e. Factory functions forward `stateRef` (lines 472-499)

`createSSETransformStreamWithLogger`: thêm tham số `stateRef = null` cuối, truyền vào `createSSEStream({ ..., stateRef })`.

`createPassthroughStreamWithLogger`: tương tự.

```js
export function createSSETransformStreamWithLogger(targetFormat, sourceFormat, provider = null, reqLogger = null, toolNameMap = null, model = null, connectionId = null, body = null, onStreamComplete = null, apiKey = null, stateRef = null) {
  return createSSEStream({
    mode: STREAM_MODE.TRANSLATE,
    targetFormat, sourceFormat, provider, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey, stateRef
  });
}

export function createPassthroughStreamWithLogger(provider = null, reqLogger = null, model = null, connectionId = null, body = null, onStreamComplete = null, apiKey = null, stateRef = null) {
  return createSSEStream({
    mode: STREAM_MODE.PASSTHROUGH,
    provider, reqLogger, model, connectionId, body, onStreamComplete, apiKey, stateRef
  });
}
```

---

## Edit 3 — `open-sse/utils/streamHandler.js` (pipeForFallbackAttempt + Phase 0 log)

### 3a. Phase 0 — log khi emitTerminal fire do network/stall error

Trong `createDisconnectAwareStream` pull-catch (lines 130-166), trước khối
`try { if (!wasConnected || isNetworkClose || onAbortTerminal) { ...` }, thêm log:

```js
// Phase 0: chẩn đoán — log mỗi khi mask lỗi mid-stream thành finish sạch
if (wasConnected && isNetworkClose) {
  console.warn(
    `[STREAM] mid-stream drop masked as close | provider=${streamController?.provider || "?"} ` +
    `model=${streamController?.model || "?"} | err=${msg || code} | ` +
    `contentLen=${0 /* không có stateRef ở path này */}`
  );
}
```

> Ghi chú: path `createDisconnectAwareStream` hiện không có stateRef (transform
> ở ngoài). Log `contentLen=0` ở đây chỉ tín hiệu "có drop". Chi tiết content
> được log ở generator fallback (Edit 4). Đủ để xác nhận cơ chế.

### 3b. THÊM hàm `pipeForFallbackAttempt` (cuối file, sau `pipeWithDisconnect`)

Pipe riêng cho attempt không-cuối: stall watchdog per-attempt, throw network/stall
error ra generator (không mask, không mark disconnected). Không chạm `pipeWithDisconnect`
hiện có → path OFF giữ nguyên 100%.

```js
/**
 * Pipe cho mid-stream fallback attempts: ném lỗi network/stall ra ngoài (controller.error)
 * để generator fallback bắt → re-prompt. Không mark streamController disconnected
 * (chỉ client disconnect mới mark). Stall watchdog dùng cờ riêng để phân biệt với
 * client-abort. Chỉ dùng khi MID_STREAM_FALLBACK_ATTEMPTS > 0.
 */
export function pipeForFallbackAttempt(providerResponse, transformStream, streamController, onAbortTerminal, stallTimeoutMs) {
  let stallTimer = null;
  let stallAborted = false;
  let chunkCount = 0;
  let totalBytes = 0;
  const clearStall = () => { if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; } };
  const armStall = () => {
    clearStall();
    stallTimer = setTimeout(() => {
      stallAborted = true;
      clearStall();
      dbg("STREAM", `FALLBACK stall ${stallTimeoutMs}ms | chunks=${chunkCount} | bytes=${totalBytes}`);
      streamController.abort?.();
    }, stallTimeoutMs);
  };

  const upstreamTap = new TransformStream({
    transform(chunk, controller) {
      chunkCount++;
      const sz = chunk?.byteLength || chunk?.length || 0;
      totalBytes += sz;
      armStall();
      controller.enqueue(chunk);
    },
    flush() { clearStall(); }
  });

  const piped = providerResponse.body.pipeThrough(upstreamTap).pipeThrough(transformStream);
  const reader = piped.getReader();
  armStall();

  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          clearStall();
          streamController.handleComplete?.();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        clearStall();
        reader.cancel().catch(() => {});
        const clientAborted = streamController.signal?.aborted && !stallAborted;
        if (clientAborted) {
          // client disconnect → graceful close (không retry)
          try { if (onAbortTerminal) controller.enqueue(onAbortTerminal()); } catch {}
          controller.close();
        } else {
          // upstream network/stall error → ném ra cho generator fallback
          controller.error(error);
        }
      }
    },
    cancel(reason) {
      clearStall();
      reader.cancel().catch(() => {});
    }
  });
}
```

> Cần `dbg` đã import ở đầu file (đã có: `import { dbg, isDebugEnabled } from "./debugLog.js";`).
> `streamController.provider`/`.model` không có trên object hiện tại (chỉ có signal/startTime/...).
> Nếu muốn log provider/model trong stall, truyền thêm vào createStreamController — OPTIONAL.

---

## Edit 4 — `open-sse/handlers/chatCore/streamingHandler.js` (fallback path)

### 4a. Imports

Thêm vào đầu:
```js
import { MID_STREAM_FALLBACK_ATTEMPTS } from "../../config/runtimeConfig.js";
```

### 4b. `buildTransformStream` chấp nhận + forward `stateRef`

Sửa signature (line 38) thêm `stateRef` và forward vào 3 nhánh `createSSETransformStreamWithLogger`/`createPassthroughStreamWithLogger`:

```js
function buildTransformStream({ provider, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey, stateRef }) {
  const isDroidCLI = userAgent?.toLowerCase().includes("droid") || userAgent?.toLowerCase().includes("codex-cli");
  const isResponsesProvider = PROVIDERS[provider]?.format === FORMATS.OPENAI_RESPONSES;
  const needsCodexTranslation = isResponsesProvider && targetFormat === FORMATS.OPENAI_RESPONSES && !isDroidCLI;

  if (needsCodexTranslation) {
    const codexTarget = CODEX_SOURCE_TO_TARGET[sourceFormat] || FORMATS.OPENAI;
    return createSSETransformStreamWithLogger(FORMATS.OPENAI_RESPONSES, codexTarget, provider, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey, stateRef);
  }

  if (needsTranslation(targetFormat, sourceFormat)) {
    return createSSETransformStreamWithLogger(targetFormat, sourceFormat, provider, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey, stateRef);
  }

  return createPassthroughStreamWithLogger(provider, reqLogger, model, connectionId, body, onStreamComplete, apiKey, stateRef);
}
```

### 4c. `handleStreamingResponse` — thêm params + path fallback

Sửa signature (line 59) thêm: `executor`, `credentials`, `proxyOptions`, `log`,
`upstreamModel`, `signal`, `streamController` (streamController đã có). Thêm import
`pipeForFallbackAttempt`. Logic: nếu `MID_STREAM_FALLBACK_ATTEMPTS > 0` → dùng
generator fallback; else path hiện tại (giữ nguyên).

```js
import { pipeWithDisconnect, pipeForFallbackAttempt } from "../../utils/streamHandler.js";
import { ensureReasoningModelMaxTokens } from "../chatCore.js"; // export hàm này (xem Edit 5)
// (hoặc duplicate hàm nhỏ này tại đây để tránh circular import — xem note Edit 5)
```

Body mới của `handleStreamingResponse` (giữ phần đầu `onRequestSuccess`, content-type
warn, `buildTransformStream`, `onAbortTerminal`, `stallTimeoutMs` như cũ; chỉ thay
phần `transformedBody`/return ở cuối):

```js
export function handleStreamingResponse({ providerResponse, provider, model, sourceFormat, targetFormat, userAgent, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess, reqLogger, toolNameMap, streamController, onStreamComplete, executor, credentials, proxyOptions, log, upstreamModel }) {
  if (onRequestSuccess) {
    Promise.resolve().then(onRequestSuccess).catch(err => { console.error("[ChatCore] onRequestSuccess failed:", err?.message || err); });
  }

  const upstreamContentType = (providerResponse.headers.get('content-type') || '').toLowerCase();
  if (upstreamContentType && !upstreamContentType.includes('text/event-stream') && !upstreamContentType.includes('application/json')) {
    console.warn('[STREAM] ' + provider + ' | ' + model + ' | unexpected Content-Type: ' + upstreamContentType);
  }

  const isResponsesPassthrough = sourceFormat === FORMATS.OPENAI_RESPONSES && targetFormat === FORMATS.OPENAI_RESPONSES;
  const isOpenAIPassthrough = sourceFormat === FORMATS.OPENAI && targetFormat === FORMATS.OPENAI && !GEMINI_FAMILY_PROVIDERS.has(provider);
  const onAbortTerminal = isResponsesPassthrough
    ? buildAbortedResponsesTerminalBytes
    : isOpenAIPassthrough
      ? buildAbortedOpenAIPassthroughTerminalBytes
      : null;
  const stallTimeoutMs = PROVIDERS[provider]?.stallTimeoutMs || STREAM_STALL_TIMEOUT_MS;

  const streamDetailId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  saveRequestDetail(buildRequestDetail({
    provider, model, connectionId,
    latency: { ttft: 0, total: Date.now() - requestStartTime },
    tokens: { prompt_tokens: 0, completion_tokens: 0 },
    request: extractRequestConfig(body, stream),
    providerRequest: finalBody || translatedBody || null,
    providerResponse: "[Streaming - raw response not captured]",
    response: { content: "[Streaming in progress...]", thinking: null, type: "streaming" },
    status: "success"
  }, { id: streamDetailId })).catch(err => { console.error("[RequestDetail] Failed to save streaming request:", err.message); });

  // --- Fallback path (opt-in) ---
  if (MID_STREAM_FALLBACK_ATTEMPTS > 0 && executor && streamController) {
    const readable = streamWithFallbackToReadable({
      firstProviderResponse: providerResponse,
      executor, model, translatedBody, upstreamModel,
      credentials, signal: streamController.signal, log, proxyOptions,
      provider, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap,
      connectionId, apiKey, body, onStreamComplete,
      streamController, onAbortTerminal, stallTimeoutMs,
      maxAttempts: MID_STREAM_FALLBACK_ATTEMPTS
    });
    return { success: true, response: new Response(readable, { headers: SSE_HEADERS }) };
  }

  // --- Current path (OFF hoặc thiếu executor) — GIỮ NGUYÊN ---
  const transformStream = buildTransformStream({ provider, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey });
  const transformedBody = pipeWithDisconnect(providerResponse, transformStream, streamController, onAbortTerminal, stallTimeoutMs);
  return { success: true, response: new Response(transformedBody, { headers: SSE_HEADERS }) };
}
```

### 4d. THÊM 2 helper: `streamWithFallbackToReadable` + `streamWithFallbackGenerator` + `buildContinuationBody`

Đặt cuối file `streamingHandler.js`:

```js
// Build continuation body: thêm system-instruction + assistant message chứa partial content.
// KHÔNG dùng prefix:true (NIM/OpenAI-compatible có thể 400). Rủi ro duplicate reasoning
// được giảm bởi system instruction. v1 opt-in — chấp nhận để có content thay vì rỗng.
function buildContinuationBody(originalBody, partialContent) {
  const messages = Array.isArray(originalBody.messages) ? [...originalBody.messages] : [];
  messages.push({
    role: "system",
    content: "You are continuing an assistant response that was interrupted mid-generation. Pick up exactly where the previous assistant message left off and output ONLY the remaining answer. Do not repeat prior content. Do not redo reasoning/thinking."
  });
  messages.push({ role: "assistant", content: partialContent });
  return { ...originalBody, messages, stream: true };
}

async function* streamWithFallbackGenerator({
  firstProviderResponse, executor, model, translatedBody, upstreamModel,
  credentials, signal, log, proxyOptions,
  provider, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap,
  connectionId, apiKey, body, onStreamComplete,
  streamController, onAbortTerminal, stallTimeoutMs, maxAttempts
}) {
  let providerResponse = firstProviderResponse;
  let currentBody = translatedBody;
  const totalAttempts = maxAttempts + 1;

  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    const isLast = attempt === maxAttempts; // attempt cuối dùng pipeWithDisconnect (swallow, path hiện tại)
    const stateRef = {};
    const transformStream = buildTransformStream({
      provider, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap,
      model, connectionId, body, onStreamComplete, apiKey, stateRef
    });

    let readable;
    if (isLast) {
      readable = pipeWithDisconnect(providerResponse, transformStream, streamController, onAbortTerminal, stallTimeoutMs);
    } else {
      readable = pipeForFallbackAttempt(providerResponse, transformStream, streamController, onAbortTerminal, stallTimeoutMs);
    }

    const reader = readable.getReader();
    let bytesSent = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return; // clean finish → xong toàn bộ response
        const sz = value?.byteLength || value?.length || 0;
        bytesSent += sz;
        yield value;
      }
    } catch (err) {
      if (isLast) {
        // attempt cuối dùng pipeWithDisconnect (swallow) → không ném. Nhưng phòng hờ:
        try { if (onAbortTerminal) yield onAbortTerminal(); } catch {}
        return;
      }
      const partial = stateRef.accumulatedContent || "";
      console.warn(
        `[FALLBACK] attempt ${attempt + 1}/${totalAttempts} mid-stream err | ${provider}/${model} | ` +
        `bytesSent=${bytesSent} | contentLen=${partial.length} | ${err?.message || err}`
      );

      // Quyết định body retry (theo litellm is_pre_first_chunk):
      if (bytesSent === 0 || !partial) {
        currentBody = translatedBody; // chưa gửi gì cho client → retry nguyên bản
      } else {
        currentBody = buildContinuationBody(translatedBody, partial);
      }

      // Re-execute upstream
      try {
        const result = await executor.execute({
          model, body: currentBody, stream: true, credentials, signal, log, proxyOptions
        });
        if (!result.response.ok) {
          console.warn(`[FALLBACK] re-execute non-ok: ${result.response.status} | ${provider}/${model}`);
          try { if (onAbortTerminal) yield onAbortTerminal(); } catch {}
          return;
        }
        providerResponse = result.response;
      } catch (e) {
        console.warn(`[FALLBACK] re-execute threw: ${e?.message || e} | ${provider}/${model}`);
        try { if (onAbortTerminal) yield onAbortTerminal(); } catch {}
        return;
      }
      // loop → attempt tiếp theo với providerResponse mới
    }
  }
}

// Wrap async generator thành ReadableStream cho `new Response(body)`.
function streamWithFallbackToReadable(params) {
  const gen = streamWithFallbackGenerator(params);
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await gen.next();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (e) {
        controller.error(e);
      }
    },
    async cancel(reason) {
      try { params.streamController.handleDisconnect?.(reason || "client_closed"); } catch {}
      try { await gen.return(); } catch {}
    }
  });
}
```

---

## Edit 5 — `open-sse/handlers/chatCore.js` (export + truyền params)

### 5a. Export `ensureReasoningModelMaxTokens`

Sửa dòng 49 `function ensureReasoningModelMaxTokens(...)` → `export function ensureReasoningModelMaxTokens(...)`.

> Note: `streamingHandler.js` import từ `chatCore.js`. Nếu lo circular import
> (chatCore.js import streamingHandler.js ở line 19, và streamingHandler import
> lại chatCore.js), thì Thay vì import, **duplicate** `ensureReasoningModelMaxTokens`
> + `REASONING_MODEL_PATTERNS` + `isReasoningModel` vào streamingHandler.js
> (nhỏ, tự chứa). Khuyến nghị: duplicate để tránh circular. Thực tế generator
> KHÔNG cần ensureReasoningModelMaxTokens (translatedBody đã được ensure ở
> chatCore.js:272 trước khi vào handleStreamingResponse, và continuation body
> kế thừa max_tokens từ translatedBody). → **Bỏ luôn, không cần export, không
> cần duplicate.** (Đã điều chỉnh: generator dùng currentBody/translatedBody
> trực tiếp, không re-ensure.) → Edit 5a BỎ.

### 5b. Truyền params mới vào `handleStreamingResponse` (line 364)

BEFORE:
```js
return handleStreamingResponse({ ...sharedCtx, providerResponse, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, streamController, onStreamComplete });
```

AFTER:
```js
return handleStreamingResponse({
  ...sharedCtx, providerResponse, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, streamController, onStreamComplete,
  executor, credentials, proxyOptions, log, upstreamModel
});
```

`sharedCtx` (line 345) đã có provider/model/body/stream/translatedBody/finalBody/
requestStartTime/connectionId/apiKey/clientRawRequest/onRequestSuccess. Các biến
`executor`(219), `credentials`(param), `proxyOptions`(235), `log`(param),
`upstreamModel`(85) đều ở scope `handleChatCore` → truyền được.

---

## Kích hoạt & verify

1. Build: `npm run build` (9router).
2. Unit: `npx vitest run tests/unit/openai-to-claude.test.js tests/unit/openai-to-claude-response-tools.test.js` (không nên regress vì path OFF = code cũ).
3. Deploy lên diepcabenbi, set env `MID_STREAM_FALLBACK_ATTEMPTS=1` (hoặc 2), restart.
4. Repro: opencode → litellm(`kimi-k2.6-9router`) → 9router(diepcabenbi) → NIM, task reasoning nặng.
5. Theo dõi log:
   - Phase 0: `[STREAM] mid-stream drop masked as close ...` → xác nhận có drop.
   - Fallback: `[FALLBACK] attempt 1/2 mid-stream err ... contentLen=...` → fallback fire.
   - Nếu content về đủ sau fallback → fixed.
   - Nếu `[FALLBACK] re-execute non-ok` → continuation body bị NIM reject → điều chỉnh (thêm prefix hoặc strip field).
6. So sánh: gọi `kimi-k2.6` (litellm thẳng NIM) vs `kimi-k2.6-9router` (qua 9router) — cùng task, content phải về đủ cả hai.
7. Nếu vẫn rỗng và KHÔNG thấy log fallback fire → cơ chế khác (max_tokens field absent / stall > 360s). Lúc đó:
   - Tăng `STREAM_STALL_TIMEOUT_MS=600000` (600s, bằng litellm read timeout).
   - Wire `STREAM_FIRST_CHUNK_TIMEOUT_MS` cho prefill riêng (hiện defined nhưng chưa dùng).
   - Kiểm tra opencode có gửi `max_tokens` không; nếu không, mở rộng `ensureReasoningModelMaxTokens` để inject 64000 khi field absent (không chỉ khi ≤32000).

---

## Rủi ro & rollback

- **OFF (default)**: 0 risk — path hiện tại giữ nguyên, code mới không chạy.
- **ON**: rủi ro chính = continuation body gây NIM duplicate reasoning hoặc 400.
  Mitigation: system instruction + omit `prefix:true`; nếu 400 → fallback emit
  terminal (không worse hiện tại). Rollback: set env = 0, restart.
- **Circular import**: không (generator không import ensureReasoningModelMaxTokens).
- **stateRef**: object rỗng truyền ref, transform ghi thêm field — không ảnh hưởng
  path cũ (stateRef=null → skip ghi).
- **pipeForFallbackAttempt**: hàm mới riêng, không chạm pipeWithDisconnect →
  path OFF 100% như cũ.

## Tóm tắt files sửa

| File | Edit | Phase |
|---|---|---|
| `open-sse/config/runtimeConfig.js` | Thêm `MID_STREAM_FALLBACK_ATTEMPTS` | 2A |
| `open-sse/utils/stream.js` | stateRef + fix accumulation (passthrough + translate) | 0 + 2A |
| `open-sse/utils/streamHandler.js` | log emitTerminal + thêm `pipeForFallbackAttempt` | 0 + 2A |
| `open-sse/handlers/chatCore/streamingHandler.js` | stateRef trong buildTransformStream + fallback path + 3 helper | 2A |
| `open-sse/handlers/chatCore.js` | truyền executor/credentials/proxyOptions/log/upstreamModel | 2A |
