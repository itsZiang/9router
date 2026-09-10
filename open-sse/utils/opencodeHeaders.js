import { randomUUID } from "crypto";
import { setUserAgentHeader } from "../executors/base";

/**
 * Header keys that are forwarded from the client to the upstream provider.
 * Used by both OpencodeExecutor and DefaultExecutor.
 */
const OPENCODE_HEADER_KEYS = ["x-opencode-session", "x-opencode-request", "x-opencode-project", "x-opencode-client"];

/**
 * Fake OpenCode CLI fingerprint for the Zen free tier.
 *
 * Upstream `https://opencode.ai/zen/v1` gates free models (`*-free`, `big-pickle`,
 * `muse-spark-*-contributor-free`, `nemotron-*`, ...) by HTTP identity headers:
 * requests that look like the official `opencode` CLI get the normal free quota,
 * everything else gets `400 OpenCode's free tier can only be used in OpenCode`
 * (or `429 FreeUsageLimitError` on the anonymous bucket).
 *
 * Verified behavior (pi#2824, dsh-zen-proxy, opencode#42500):
 * - `x-opencode-*` alone is NOT enough — the gateway validates `User-Agent` content.
 * - Only `User-Agent: opencode/<version>...` unlocks the official-client quota.
 * - Official CLI sends:
 *     User-Agent: opencode/1.15.5 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14
 *     x-opencode-client: cli
 *     x-opencode-project: global
 *     x-opencode-session: ses_<random> (per request)
 *     x-opencode-request: msg_<random> (per request)
 *
 * 9router clients typically arrive via `@ai-sdk/openai-compatible` (UA like
 * `ai-sdk/...` or `OpenAI/JS ...`), so without spoofing every proxied free-tier
 * call is rejected even though routing + auth are correct.
 */
export const OPENCODE_FAKE_USER_AGENT =
  process.env.OMNIROUTE_OPENCODE_USER_AGENT?.trim() ||
  "opencode/1.18.27 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14";
export const OPENCODE_FAKE_CLIENT = process.env.OMNIROUTE_OPENCODE_CLIENT?.trim() || "cli";
export const OPENCODE_FAKE_PROJECT = process.env.OMNIROUTE_OPENCODE_PROJECT?.trim() || "global";

function isFakeDisabled() {
  const v = (process.env.OMNIROUTE_OPENCODE_FAKE_HEADERS ?? "").trim().toLowerCase();
  return v === "0" || v === "false" || v === "off" || v === "no";
}

function isOpencodeUA(ua) {
  return typeof ua === "string" && ua.trim().toLowerCase().startsWith("opencode/");
}

function randomId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}
function findHeader(headers, name) {
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

/**
 * Forward OpenCode client request metadata headers to the upstream provider.
 *
 * Shared logic used by OpencodeExecutor and DefaultExecutor:
 * 1. Forwards User-Agent from clientHeaders via `setUserAgentHeader()`
 * 2. Forwards x-opencode-session, x-opencode-request, x-opencode-project,
 *    x-opencode-client headers (case-insensitive match)
 *
 * @param headers - The outbound headers record to mutate
 * @param clientHeaders - The client-provided headers to forward from
 * @param options.synthesizeRequestId - When true (OpencodeExecutor only), maps
 *   x-session-affinity / x-session-id to x-opencode-session when the latter is
 *   missing, and synthesizes a UUID for x-opencode-request if also missing.
 */
export function forwardOpencodeClientHeaders(headers, clientHeaders, options) {
  // 1. Forward User-Agent
  const clientUA = clientHeaders["User-Agent"] || clientHeaders["user-agent"];
  if (clientUA) {
    setUserAgentHeader(headers, clientUA);
  }

  // 2. Forward x-opencode-* metadata headers
  for (const headerName of OPENCODE_HEADER_KEYS) {
    const value = findHeader(clientHeaders, headerName);
    if (value) {
      headers[headerName] = value;
    }
  }

  // 3. OpencodeExecutor-only: synthesize session/request id from fallback headers
  if (options?.synthesizeRequestId && !headers["x-opencode-session"]) {
    const sessionAffinity = findHeader(clientHeaders, "x-session-affinity") || findHeader(clientHeaders, "x-session-id");
    if (sessionAffinity) {
      headers["x-opencode-session"] = sessionAffinity;
      if (!headers["x-opencode-request"]) {
        headers["x-opencode-request"] = randomUUID();
      }
    }
  }
}

/**
 * Fill any missing OpenCode identity headers with official-CLI-looking values
 * so Zen free-tier requests are treated as first-party traffic.
 *
 * Behavior:
 * - Keeps real `opencode/*` client values untouched (real CLI passes through).
 * - Overrides non-opencode `User-Agent` (e.g. `ai-sdk/...`, `OpenAI/JS ...`,
 *   `Mozilla/5.0 ...`) with {@link OPENCODE_FAKE_USER_AGENT} — the gateway
 *   checks UA *content*, headers alone are not enough (opencode#42500).
 * - Defaults `x-opencode-client` to `cli`, `x-opencode-project` to `global`,
 *   synthesizes `ses_*` / `msg_*` ids per request when absent.
 * - No-op when `OMNIROUTE_OPENCODE_FAKE_HEADERS=0/false/off/no`.
 *
 * Must run AFTER `forwardOpencodeClientHeaders()` and BEFORE
 * `stripStainlessHeadersForOpenAICompat()` (the strip only normalizes UAs
 * containing "openai", so the fake `opencode/...` UA survives it).
 */
export function applyOpencodeFakeFingerprint(headers, clientHeaders = null) {
  if (isFakeDisabled()) return headers;
  // x-opencode-client
  if (!headers["x-opencode-client"]) {
    const client = clientHeaders ? findHeader(clientHeaders, "x-opencode-client") : null;
    headers["x-opencode-client"] = client || OPENCODE_FAKE_CLIENT;
  }
  // x-opencode-project
  if (!headers["x-opencode-project"]) {
    const project = clientHeaders ? findHeader(clientHeaders, "x-opencode-project") : null;
    headers["x-opencode-project"] = project || OPENCODE_FAKE_PROJECT;
  }
  // x-opencode-session (per-request random when absent)
  if (!headers["x-opencode-session"]) {
    headers["x-opencode-session"] = randomId("ses");
  }
  // x-opencode-request (per-request random when absent)
  if (!headers["x-opencode-request"]) {
    headers["x-opencode-request"] = randomId("msg");
  }
  // User-Agent: keep genuine opencode/* clients, spoof everything else.
  const currentUA = headers["User-Agent"] || headers["user-agent"];
  if (!isOpencodeUA(currentUA)) {
    setUserAgentHeader(headers, OPENCODE_FAKE_USER_AGENT);
  }
  return headers;
}