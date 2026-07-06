import { FORMATS } from "../../translator/formats.js";
import { needsTranslation } from "../../translator/index.js";
import { createSSETransformStreamWithLogger, createPassthroughStreamWithLogger } from "../../utils/stream.js";
import { createNormalizedStream } from "../../streaming/createNormalizedStream.js";
import { pipeWithDisconnect } from "../../utils/streamHandler.js";
import { PROVIDERS } from "../../config/providers.js";
import { STREAM_STALL_TIMEOUT_MS, SSE_HEARTBEAT_INTERVAL_MS } from "../../config/runtimeConfig.js";
import { buildAbortedResponsesTerminalBytes } from "../../utils/responsesStreamHelpers.js";
import { buildRequestDetail, extractRequestConfig, saveUsageStats } from "./requestDetail.js";
import { saveRequestDetail, trackPendingRequest } from "@/lib/usageDb.js";
import { SSE_HEADERS_CORS as SSE_HEADERS } from "../../utils/sseConstants.js";
import { createSseHeartbeatTransform, HEARTBEAT_SHAPES } from "../../utils/sseHeartbeat.js";

// Shared encoder for terminal byte synthesis
const _sharedEncoder = new TextEncoder();

// Synthesize [DONE] sentinel for aborted OpenAI passthrough streams.
// Clients (e.g. opencode via @ai-sdk/openai-compatible) expect this sentinel
// to properly terminate the SSE stream. Without it they may hang or report truncation.
function buildAbortedOpenAIPassthroughTerminalBytes() {
  const finishChunk = `data: ${JSON.stringify({
    id: `chatcmpl-${Date.now().toString(36)}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  })}\n\n`;
  return _sharedEncoder.encode(`${finishChunk}data: [DONE]\n\n`);
}

// Gemini-family clients reject the [DONE] sentinel with 400 syntax errors
const GEMINI_FAMILY_PROVIDERS = new Set(["antigravity", "gemini", "vertex", "gemini-cli"]);

// Build format-appropriate terminal bytes for aborted streams (translate + passthrough).
// Ensures clients always receive a proper terminal event even when the upstream drops mid-stream.
function buildAbortedTerminalBytes(sourceFormat, provider) {
  if (GEMINI_FAMILY_PROVIDERS.has(provider)) return null;

  if (sourceFormat === FORMATS.CLAUDE) {
    return _sharedEncoder.encode("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
  }

  // OpenAI and OpenAI-compatible (includes translate mode where sourceFormat is OpenAI)
  return buildAbortedOpenAIPassthroughTerminalBytes();
}

// Codex returns Responses API SSE → which client format to translate INTO, by request sourceFormat.
// Gemini-family all map to ANTIGRAVITY decoder; unknown sources fall back to OPENAI.
const CODEX_SOURCE_TO_TARGET = {
  [FORMATS.OPENAI_RESPONSES]: FORMATS.OPENAI_RESPONSES,
  [FORMATS.CLAUDE]: FORMATS.CLAUDE,
  [FORMATS.ANTIGRAVITY]: FORMATS.ANTIGRAVITY,
  [FORMATS.GEMINI]: FORMATS.ANTIGRAVITY,
  [FORMATS.GEMINI_CLI]: FORMATS.ANTIGRAVITY,
};

/**
 * Determine which SSE transform stream to use based on provider/format.
 */
function buildTransformStream({ provider, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey, responseIterator }) {
  // If provider offers a response iterator, insert normalization before translation.
  // This decouples provider-specific chunk parsing from the monolithic transform stream.
  if (responseIterator) {
    return createNormalizedStream({
      responseIterator,
      mode: needsTranslation(targetFormat, sourceFormat) ? "translate" : "passthrough",
      sourceFormat,
      provider,
      reqLogger,
      model,
      connectionId,
      body,
      onStreamComplete,
      apiKey,
      toolNameMap,
    });
  }

  const isDroidCLI = userAgent?.toLowerCase().includes("droid") || userAgent?.toLowerCase().includes("codex-cli");
  // Responses-API providers (e.g. codex) emit Responses SSE → translate into client format
  const isResponsesProvider = PROVIDERS[provider]?.format === FORMATS.OPENAI_RESPONSES;
  const needsCodexTranslation = isResponsesProvider && targetFormat === FORMATS.OPENAI_RESPONSES && !isDroidCLI;

  if (needsCodexTranslation) {
    const codexTarget = CODEX_SOURCE_TO_TARGET[sourceFormat] || FORMATS.OPENAI;
    return createSSETransformStreamWithLogger(FORMATS.OPENAI_RESPONSES, codexTarget, provider, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey);
  }

  if (needsTranslation(targetFormat, sourceFormat)) {
    return createSSETransformStreamWithLogger(targetFormat, sourceFormat, provider, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey);
  }

  return createPassthroughStreamWithLogger(provider, reqLogger, model, connectionId, body, onStreamComplete, apiKey);
}

/**
 * Handle streaming response — pipe provider SSE through transform stream to client.
 */
export function handleStreamingResponse({ providerResponse, provider, model, sourceFormat, targetFormat, userAgent, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess, reqLogger, toolNameMap, streamController, onStreamComplete, retryMetadata, responseIterator }) {
  if (onRequestSuccess) {
    Promise.resolve()
      .then(onRequestSuccess)
      .catch(err => {
        console.error("[ChatCore] onRequestSuccess failed:", err?.message || err);
      });
  }

  // Warn when upstream returns unexpected Content-Type for a streaming response.
  // This often means the provider returned an HTML error page or plain-text error
  // that the SSE transform stream would forward as garbage to the client.
  const upstreamContentType = (providerResponse.headers.get('content-type') || '').toLowerCase();
  if (upstreamContentType && !upstreamContentType.includes('text/event-stream') && !upstreamContentType.includes('application/json')) {
    console.warn('[STREAM] ' + provider + ' | ' + model + ' | unexpected Content-Type: ' + upstreamContentType);
  }

  // Guard onStreamComplete so it fires exactly once — even when the upstream
  // errors mid-stream and the transform's flush() is never called.
  let streamCompleteCalled = false;
  const guardedOnStreamComplete = (contentObj, usage, ttftAt) => {
    if (streamCompleteCalled) return;
    streamCompleteCalled = true;
    trackPendingRequest(model, provider, connectionId, false);
    try {
      onStreamComplete?.(contentObj, usage, ttftAt);
    } catch (err) {
      console.error("[Stream] onStreamComplete callback failed:", err?.message || err);
    }
  };
  // Fallback for when the stream errors before flush() can run
  const onStreamError = () => {
    guardedOnStreamComplete({ content: null, thinking: null }, null, null);
  };

  const transformStream = buildTransformStream({ provider, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete: guardedOnStreamComplete, apiKey, responseIterator });

  // Build format-appropriate terminal bytes for aborted/stalled streams.
  // Responses passthrough has its own terminal format; all other formats use
  // buildAbortedTerminalBytes which covers both passthrough and translate modes.
  const isResponsesPassthrough = sourceFormat === FORMATS.OPENAI_RESPONSES && targetFormat === FORMATS.OPENAI_RESPONSES;
  const onAbortTerminal = isResponsesPassthrough
    ? buildAbortedResponsesTerminalBytes
    : buildAbortedTerminalBytes(sourceFormat, provider);
  const stallTimeoutMs = PROVIDERS[provider]?.stallTimeoutMs || STREAM_STALL_TIMEOUT_MS;
  const transformedBody = pipeWithDisconnect(providerResponse, transformStream, streamController, onAbortTerminal, stallTimeoutMs, onStreamError);

  // SSE heartbeat: emit keepalive events during idle periods (e.g. long reasoning)
  // to prevent NAT/load balancers from dropping the client connection.
  const heartbeatInterval = PROVIDERS[provider]?.heartbeatIntervalMs ?? SSE_HEARTBEAT_INTERVAL_MS;
  const bodyWithHeartbeat = heartbeatInterval > 0
    ? transformedBody.pipeThrough(
        createSseHeartbeatTransform({
          intervalMs: heartbeatInterval,
          signal: streamController.signal,
          shape: HEARTBEAT_SHAPES.COMMENT,
        })
      )
    : transformedBody;

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
  }, { id: streamDetailId })).catch(err => {
    console.error("[RequestDetail] Failed to save streaming request:", err.message);
  });

  const headers = new Headers(SSE_HEADERS);
  if (retryMetadata) {
    headers.set("x-9router-attempted-retries", String(retryMetadata.attemptedRetries || 0));
    headers.set("x-9router-max-retries", String(retryMetadata.maxRetries || 0));
  }

  return {
    success: true,
    response: new Response(bodyWithHeartbeat, { headers })
  };
}

/**
 * Build onStreamComplete callback for streaming usage tracking.
 */
export function buildOnStreamComplete({ provider, model, connectionId, apiKey, requestStartTime, body, stream, finalBody, translatedBody, clientRawRequest }) {
  const streamDetailId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

  const onStreamComplete = (contentObj, usage, ttftAt) => {
    const latency = {
      ttft: ttftAt ? ttftAt - requestStartTime : Date.now() - requestStartTime,
      total: Date.now() - requestStartTime
    };
    const safeContent = contentObj?.content || "[Empty streaming response]";
    const safeThinking = contentObj?.thinking || null;

    saveRequestDetail(buildRequestDetail({
      provider, model, connectionId,
      latency,
      tokens: usage || { prompt_tokens: 0, completion_tokens: 0 },
      request: extractRequestConfig(body, stream),
      providerRequest: finalBody || translatedBody || null,
      providerResponse: safeContent,
      response: { content: safeContent, thinking: safeThinking, type: "streaming" },
      status: "success"
    }, { id: streamDetailId })).catch(err => {
      console.error("[RequestDetail] Failed to update streaming content:", err.message);
    });

    saveUsageStats({ provider, model, tokens: usage, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, label: "STREAM USAGE" });
  };

  return { onStreamComplete, streamDetailId };
}
