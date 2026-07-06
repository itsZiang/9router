/**
 * Request Deduplication Service
 *
 * Deduplicates **concurrent** identical requests to the same upstream.
 * Inspired by ClawRouter's dedup.ts (BlockRunAI / github.com/BlockRunAI/ClawRouter).
 *
 * IMPORTANT: In-memory only — does NOT persist across restarts and does NOT
 * work across multiple process instances (no cross-instance dedup).
 */

import { createHash } from "node:crypto";
const MAX_INFLIGHT = 1000;
export const DEFAULT_DEDUP_CONFIG = {
  enabled: true,
  maxTemperatureForDedup: 0.1,
  timeoutMs: 60_000
};
const inflight = new Map();

/**
 * Compute a deterministic hash for a request body.
 * Includes: model, messages, temperature, tools, tool_choice, max_tokens, response_format
 * Excludes: stream, user, metadata (don't affect LLM output)
 */
export function computeRequestHash(requestBody) {
  const body = requestBody;
  const canonical = {
    model: body.model ?? null,
    messages: body.messages ?? null,
    temperature: typeof body.temperature === "number" ? body.temperature : 1.0,
    tools: body.tools ?? null,
    tool_choice: body.tool_choice ?? null,
    max_tokens: body.max_tokens ?? null,
    response_format: body.response_format ?? null,
    top_p: body.top_p ?? null,
    frequency_penalty: body.frequency_penalty ?? null,
    presence_penalty: body.presence_penalty ?? null
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 16);
}

/** Determine whether a request should be deduplicated */
export function shouldDeduplicate(requestBody, config = DEFAULT_DEDUP_CONFIG) {
  if (!config.enabled) return false;
  const body = requestBody;
  if (body.stream === true) return false;
  const temperature = typeof body.temperature === "number" ? body.temperature : 1.0;
  if (temperature > config.maxTemperatureForDedup) return false;
  return true;
}

/**
 * Execute a request with deduplication.
 * Concurrent identical requests share one upstream call.
 */
export async function deduplicate(hash, fn, config = DEFAULT_DEDUP_CONFIG) {
  if (!config.enabled) {
    return {
      result: await fn(),
      wasDeduplicated: false,
      hash
    };
  }
  const existing = inflight.get(hash);
  if (existing) {
    const result = await existing;
    return {
      result,
      wasDeduplicated: true,
      hash
    };
  }
  if (inflight.size >= MAX_INFLIGHT) {
    const oldestKey = inflight.keys().next().value;
    if (oldestKey !== undefined) inflight.delete(oldestKey);
  }
  let resolve;
  let reject;
  const sharedPromise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  inflight.set(hash, sharedPromise);
  const timer = setTimeout(() => {
    if (inflight.get(hash) === sharedPromise) inflight.delete(hash);
  }, config.timeoutMs);
  try {
    const result = await fn();
    resolve(result);
    return {
      result,
      wasDeduplicated: false,
      hash
    };
  } catch (err) {
    reject(err);
    throw err;
  } finally {
    clearTimeout(timer);
    if (inflight.get(hash) === sharedPromise) inflight.delete(hash);
  }
}
export function getInflightCount() {
  return inflight.size;
}
export function getInflightHashes() {
  return [...inflight.keys()];
}
export function clearInflight() {
  inflight.clear();
}