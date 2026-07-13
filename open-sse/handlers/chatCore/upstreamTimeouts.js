import { FETCH_TIMEOUT_MS } from "../../config/constants";
import { getLoggedInputTokens, getLoggedOutputTokens, getReasoningTokens } from "../../stubs/lib/usage/tokenAccounting";
export function createBodyTimeoutError(timeoutMs) {
  const err = new Error(`Response body read timeout after ${timeoutMs}ms`);
  err.name = "BodyTimeoutError";
  return err;
}
export function readStreamChunkWithTimeout(reader, timeoutMs) {
  if (timeoutMs <= 0) return reader.read();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(createBodyTimeoutError(timeoutMs)), timeoutMs);
    reader.read().then(value => {
      clearTimeout(timeout);
      resolve(value);
    }, error => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}
export function createUpstreamStartTimeoutError(timeoutMs, provider, model) {
  const err = new Error(`Upstream request did not return response headers after ${timeoutMs}ms (${provider}/${model})`);
  err.name = "TimeoutError";
  return err;
}
export function createAbortError(signal) {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error(typeof reason === "string" ? reason : "The operation was aborted");
  err.name = "AbortError";
  return err;
}

/** Billable token total — mirrors the columns persisted by saveRequestUsage so the
 *  live token-limit counter stays consistent with usage_history seed-on-miss. */
export function computeBillableTokens(usage) {
  // Cache read/creation tokens are a BREAKDOWN already contained inside
  // getLoggedInputTokens (prompt_tokens / input_tokens). Adding them here would
  // double-count. Canonical billable total = input + output + reasoning, matching
  // the columns persisted by saveRequestUsage and seedWindowUsageFromHistory.
  return getLoggedInputTokens(usage) + getLoggedOutputTokens(usage) + getReasoningTokens(usage);
}
export function getExecutorTimeoutMs(executor) {
  return 0; // Disabled: no upstream timeout
}
export function normalizeExecutorResult(result) {
  if (result instanceof Response) {
    return {
      response: result,
      url: "",
      headers: {},
      transformedBody: null
    };
  }
  return {
    response: result.response,
    url: result.url || "",
    headers: result.headers || {},
    transformedBody: result.transformedBody ?? null
  };
}
export async function executeWithUpstreamStartTimeout({
  executor,
  provider,
  model,
  signal,
  log,
  execute
}) {
  const timeoutMs = getExecutorTimeoutMs(executor);
  if (timeoutMs <= 0) return execute(signal);
  if (signal.aborted) throw createAbortError(signal);
  const timeoutController = new AbortController();
  const combinedController = new AbortController();
  const timeoutError = createUpstreamStartTimeoutError(timeoutMs, provider, model);
  let timeoutId = null;
  let abortListener = null;
  let timeoutAbortListener = null;
  const abortCombined = source => {
    if (combinedController.signal.aborted) return;
    const reason = source.reason instanceof Error ? source.reason : createAbortError(source);
    combinedController.abort(reason);
  };
  abortListener = () => abortCombined(signal);
  timeoutAbortListener = () => abortCombined(timeoutController.signal);
  signal.addEventListener("abort", abortListener, {
    once: true
  });
  timeoutController.signal.addEventListener("abort", timeoutAbortListener, {
    once: true
  });
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      log?.warn?.("TIMEOUT", timeoutError.message);
      timeoutController.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });
  const abortPromise = new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(createAbortError(signal)), {
      once: true
    });
  });
  try {
    return await Promise.race([execute(combinedController.signal), timeoutPromise, abortPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (abortListener) signal.removeEventListener("abort", abortListener);
    if (timeoutAbortListener) {
      timeoutController.signal.removeEventListener("abort", timeoutAbortListener);
    }
  }
}