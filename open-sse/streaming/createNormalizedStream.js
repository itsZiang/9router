import { initState, translateResponse } from "../translator/index.js";
import { FORMATS } from "../translator/formats.js";
import { hasValuableContent, formatSSE } from "../utils/streamHelpers.js";
import {
  extractUsage,
  hasValidUsage,
  estimateUsage,
  filterUsageForFormat,
  logUsage,
} from "../utils/usageTracking.js";
import { STREAM_LOOP_THRESHOLD } from "../config/runtimeConfig.js";

const STREAM_MODE = {
  TRANSLATE: "translate",
  PASSTHROUGH: "passthrough",
};

const encoder = new TextEncoder();

/**
 * Create a normalized SSE TransformStream driven by a response iterator.
 * Raw upstream bytes are parsed into OpenAI chat.completion.chunk shape,
 * then either translated to the client format (translate mode) or
 * forwarded directly (passthrough mode).
 */
export function createNormalizedStream(options) {
  const {
    responseIterator,
    mode,
    sourceFormat,
    provider,
    reqLogger,
    model,
    connectionId,
    body,
    onStreamComplete,
    apiKey,
    toolNameMap,
  } = options;

  const state =
    mode === STREAM_MODE.TRANSLATE
      ? { ...initState(sourceFormat), provider, toolNameMap, model }
      : null;

  let totalContentLength = 0;
  let accumulatedContent = "";
  let accumulatedThinking = "";
  let ttftAt = null;
  let doneSent = false;
  let finishChunkSeen = false;
  let usage = null;
  let lastContentDelta = null;
  let consecutiveRepeatCount = 0;

  function handleItem(parsed, controller) {
    if (!parsed) return;

    if (parsed.done) {
      doneSent = true;
      return;
    }

    // Accumulate content & reasoning from normalized OpenAI chunk
    const delta = parsed.choices?.[0]?.delta;
    if (delta?.content) {
      totalContentLength += delta.content.length;
      accumulatedContent += delta.content;

      // Loop detection: track consecutive identical content deltas.
      // If a provider emits the same token N times in a row, abort the stream
      // to prevent token/connection waste. Skip empty deltas (usage/ping).
      if (delta.content === lastContentDelta) {
        consecutiveRepeatCount++;
        if (consecutiveRepeatCount >= STREAM_LOOP_THRESHOLD) {
          console.error(`[NormalizedStream] LOOP DETECTED: "${delta.content.slice(0, 50)}" repeated ${consecutiveRepeatCount} times — aborting stream`);
          controller.error(new Error("stream loop detected: repeated identical chunks"));
          return;
        }
      } else {
        lastContentDelta = delta.content;
        consecutiveRepeatCount = 1;
      }
    }
    if (delta?.reasoning_content) {
      totalContentLength += delta.reasoning_content.length;
      accumulatedThinking += delta.reasoning_content;
    }

    const isFinishChunk = parsed.choices?.[0]?.finish_reason;

    if (mode === STREAM_MODE.PASSTHROUGH) {
      if (!hasValuableContent(parsed, FORMATS.OPENAI)) return;

      if (isFinishChunk && !hasValidUsage(parsed.usage) && totalContentLength > 0) {
        const estimated = estimateUsage(body, totalContentLength, FORMATS.OPENAI, provider);
        parsed.usage = filterUsageForFormat(estimated, FORMATS.OPENAI);
        usage = estimated;
      } else if (isFinishChunk && parsed.usage) {
        usage = parsed.usage;
      }

      const output = formatSSE(parsed, sourceFormat);
      if (output) {
        reqLogger?.appendConvertedChunk?.(output);
        controller.enqueue(encoder.encode(output));
      }
      if (isFinishChunk) finishChunkSeen = true;
      return;
    }

    // TRANSLATE mode
    const extracted = extractUsage(parsed);
    if (extracted) {
      state.usage = extracted;
    }

    const translated = translateResponse(FORMATS.OPENAI, sourceFormat, parsed, state);

    if (translated?._openaiIntermediate) {
      for (const item of translated._openaiIntermediate) {
        const openaiOutput = formatSSE(item, FORMATS.OPENAI);
        reqLogger?.appendOpenAIChunk?.(openaiOutput);
      }
      delete translated._openaiIntermediate;
    }

    if (translated?.length > 0) {
      for (const item of translated) {
        if (!item) continue;
        if (!hasValuableContent(item, sourceFormat)) continue;

        const isFinishChunk =
          item.type === "message_delta" || item.choices?.[0]?.finish_reason;
        if (
          state.finishReason &&
          isFinishChunk &&
          !hasValidUsage(item.usage) &&
          totalContentLength > 0
        ) {
          const estimated = estimateUsage(body, totalContentLength, sourceFormat, provider);
          item.usage = filterUsageForFormat(estimated, sourceFormat);
          state.usage = estimated;
        } else if (state.finishReason && isFinishChunk && state.usage) {
          const buffered = { ...state.usage };
          item.usage = filterUsageForFormat(buffered, sourceFormat);
        }

        const output = formatSSE(item, sourceFormat);
        if (output) {
          reqLogger?.appendConvertedChunk?.(output);
          controller.enqueue(encoder.encode(output));
        }
      }
    }
  }

  return new TransformStream({
    transform(chunk, controller) {
      if (!ttftAt) ttftAt = Date.now();
      let items;
      try {
        items = responseIterator.parseChunk(chunk);
      } catch (err) {
        // Parsing errors must not kill the stream — log and skip the chunk
        console.error("[NormalizedStream] parseChunk error:", err?.message || err);
        return;
      }
      if (items) {
        for (const parsed of items) {
          handleItem(parsed, controller);
          if (doneSent) break;
        }
      }
    },
    flush(controller) {
      try {
        _flushImpl(controller);
      } catch (err) {
        console.error("[NormalizedStream] flush error:", err?.message || err);
        // Best-effort: ensure [DONE] is sent even if flush partially failed
        if (!doneSent) {
          try { controller.enqueue(encoder.encode("data: [DONE]\n\n")); } catch { /* controller may be closed */ }
          doneSent = true;
        }
      }
    },
  });

  function _flushImpl(controller) {
    const flushed = responseIterator.flush();
      if (flushed) {
        for (const parsed of flushed) {
          handleItem(parsed, controller);
        }
      }

      if (mode === STREAM_MODE.TRANSLATE) {
        const finalFlush = translateResponse(FORMATS.OPENAI, sourceFormat, null, state);
        if (finalFlush?._openaiIntermediate) {
          for (const item of finalFlush._openaiIntermediate) {
            const openaiOutput = formatSSE(item, FORMATS.OPENAI);
            reqLogger?.appendOpenAIChunk?.(openaiOutput);
            controller.enqueue(encoder.encode(openaiOutput));
          }
          delete finalFlush._openaiIntermediate;
        }
        if (finalFlush?.length > 0) {
          for (const item of finalFlush) {
            if (!item) continue;
            const output = formatSSE(item, sourceFormat);
            if (output) {
              reqLogger?.appendConvertedChunk?.(output);
              controller.enqueue(encoder.encode(output));
            }
          }
        }
      }

      if (mode === STREAM_MODE.PASSTHROUGH) {
        if (!hasValidUsage(usage) && totalContentLength > 0) {
          usage = estimateUsage(body, totalContentLength, FORMATS.OPENAI, provider);
        }
        if (hasValidUsage(usage)) {
          logUsage(provider, usage, model, connectionId, apiKey);
        }
        if (!finishChunkSeen) {
          const synthetic = {
            id: `chatcmpl-${Date.now().toString(36)}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: model || "",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          };
          const output = formatSSE(synthetic, sourceFormat);
          if (output) {
            controller.enqueue(encoder.encode(output));
          }
        }
      }

      if (!doneSent) {
        const doneOutput = "data: [DONE]\n\n";
        controller.enqueue(encoder.encode(doneOutput));
        doneSent = true;
      }

      if (onStreamComplete) {
        onStreamComplete(
          { content: accumulatedContent, thinking: accumulatedThinking },
          state?.usage || usage || null,
          ttftAt
        );
      }
    }
}

export default createNormalizedStream;
