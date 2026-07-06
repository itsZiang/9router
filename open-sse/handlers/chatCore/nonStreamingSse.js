import { FORMATS } from "../../translator/formats";
import { parseSSEToResponsesOutput, parseSSEToClaudeResponse, parseSSEToOpenAIResponse } from "../sseParser";
import { getHeaderValueCaseInsensitive } from "./headers";
export function parseNonStreamingSSEPayload(rawBody, preferredFormat, fallbackModel) {
  const formatsToTry = [];
  const seen = new Set();
  const queueFormat = format => {
    if (!format || seen.has(format)) return;
    seen.add(format);
    formatsToTry.push(format);
  };
  queueFormat(preferredFormat);
  queueFormat(FORMATS.OPENAI_RESPONSES);
  queueFormat(FORMATS.CLAUDE);
  queueFormat(FORMATS.OPENAI);
  for (const format of formatsToTry) {
    const parsed = format === FORMATS.OPENAI_RESPONSES ? parseSSEToResponsesOutput(rawBody, fallbackModel) : format === FORMATS.CLAUDE ? parseSSEToClaudeResponse(rawBody, fallbackModel) : parseSSEToOpenAIResponse(rawBody, fallbackModel);
    if (parsed && typeof parsed === "object") {
      return {
        body: parsed,
        format
      };
    }
  }
  return null;
}
export function convertNDJSONToSSE(rawBody) {
  const chunks = String(rawBody || "").split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
  if (chunks.length === 0) return rawBody;
  return `${chunks.map(chunk => `data: ${chunk}\n`).join("\n")}\n`;
}
export function normalizeNonStreamingEventPayload(rawBody, contentType) {
  if (contentType.includes("application/x-ndjson")) {
    return convertNDJSONToSSE(rawBody);
  }
  return rawBody;
}
export function isTruthyStreamBody(body) {
  return !!body && typeof body === "object" && body.stream === true;
}
export function isEventStreamAccepted(headers) {
  return (getHeaderValueCaseInsensitive(headers, "accept") || "").toLowerCase().includes("text/event-stream");
}
export function shouldTreatBufferedEventResponseAsExpected(upstreamStream, providerHeaders, finalBody) {
  return upstreamStream || isEventStreamAccepted(providerHeaders) || isTruthyStreamBody(finalBody);
}
const NON_STREAMING_SSE_TERMINAL_TYPES = new Set(["message_stop", "response.completed", "response.done", "response.cancelled", "response.canceled", "response.failed", "response.incomplete"]);
function isNonStreamingSseTerminalType(eventType) {
  return NON_STREAMING_SSE_TERMINAL_TYPES.has(eventType);
}
function hasClaudeTerminalMessageDelta(parsed, eventType) {
  if (eventType !== "message_delta" || !parsed || typeof parsed !== "object") return false;
  const delta = parsed.delta;
  if (!delta || typeof delta !== "object") return false;
  const stopReason = delta.stop_reason;
  return typeof stopReason === "string" ? stopReason.length > 0 : stopReason != null;
}
function processNonStreamingSseTerminalLine(state, rawLine) {
  const trimmed = rawLine.trim();
  if (!trimmed || trimmed.startsWith(":")) {
    const terminalEventOnly = !trimmed && isNonStreamingSseTerminalType(state.currentEvent);
    if (!trimmed) state.currentEvent = "";
    return terminalEventOnly;
  }
  if (trimmed.startsWith("event:")) {
    state.currentEvent = trimmed.slice(6).trim();
    return false;
  }
  if (!trimmed.startsWith("data:")) return false;
  const data = trimmed.slice(5).trim();
  if (data === "[DONE]") return true;
  if (!data) return false;

  // Hot-path optimization: the terminal SSE events we look for (message_stop,
  // response.completed, …) all carry a top-level "type" field, OR are signalled by a
  // preceding `event:` line (Claude). OpenAI chat.completion chunks carry neither and
  // terminate with `[DONE]` (handled above), so parsing every one of them here is pure
  // waste that compounds into the CPU-runaway on large buffered responses. Skip the
  // JSON.parse unless the line could actually be a typed terminal.
  if (!data.includes('"type"') && !(state.currentEvent === "message_delta" && data.includes("stop_reason"))) {
    return isNonStreamingSseTerminalType(state.currentEvent);
  }
  try {
    const parsed = JSON.parse(data);
    const eventType = parsed && typeof parsed === "object" && typeof parsed.type === "string" ? parsed.type : state.currentEvent;
    return isNonStreamingSseTerminalType(eventType) || hasClaudeTerminalMessageDelta(parsed, eventType);
  } catch {
    // Keep reading malformed data so the parser can report a useful upstream error.
    return false;
  }
}
export function appendNonStreamingSseTerminalSignal(state, chunk) {
  const lines = `${state.pendingLine}${chunk}`.split(/\r?\n/);
  state.pendingLine = lines.pop() ?? "";
  for (const rawLine of lines) {
    if (processNonStreamingSseTerminalLine(state, rawLine)) return true;
  }
  return false;
}