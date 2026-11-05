import { createHash, randomBytes } from "crypto";
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
 * - Since 2026-09-19 the Console gateway enforces a 3-part gate on free models
 *   (`*-free`, `big-pickle`, `muse-spark-*`, `nemotron-*`, ...), ALL required
 *   (verified live 2026-09-25 — any miss → 403 "can only be used from within OpenCode"):
 *   1. `stream: true` in the request body (non-streaming → instant 403).
 *   2. Agent tool declarations: a `shell` (or `bash`) + `read` function tool
 *      must be present in `tools` (tool-less requests read as non-agent traffic).
 *   3. Client identity: `User-Agent: opencode/<version>...` (≥1.18.0, older →
 *      426 UpgradeRequired), `x-opencode-client: cli`, and `x-opencode-session`
 *      matching `^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$` (26 chars; the old 24-hex
 *      form is rejected with the same 403).
 * - Official CLI sends:
 *     User-Agent: opencode/1.18.31 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14
 *     x-opencode-client: cli
 *     x-opencode-project: global
 *     x-opencode-session: ses_<12hex><14base62> (per session)
 *     x-opencode-request: msg_<12hex><14base62> (per request)
 *
 * 9router clients typically arrive via `@ai-sdk/openai-compatible` (UA like
 * `ai-sdk/...` or `OpenAI/JS ...`), so without spoofing every proxied free-tier
 * call is rejected even though routing + auth are correct.
 */
export const OPENCODE_FAKE_USER_AGENT =
  process.env.OMNIROUTE_OPENCODE_USER_AGENT?.trim() ||
  "opencode/1.18.31 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14";
export const OPENCODE_FAKE_CLIENT = process.env.OMNIROUTE_OPENCODE_CLIENT?.trim() || "cli";
export const OPENCODE_FAKE_PROJECT = process.env.OMNIROUTE_OPENCODE_PROJECT?.trim() || "global";

function isFakeDisabled() {
  const v = (process.env.OMNIROUTE_OPENCODE_FAKE_HEADERS ?? "").trim().toLowerCase();
  return v === "0" || v === "false" || v === "off" || v === "no";
}

function isOpencodeUA(ua) {
  return typeof ua === "string" && ua.trim().toLowerCase().startsWith("opencode/");
}

// Console free-tier gate validates `ses_*` as `ses_` + 12 lowercase hex +
// 14 base62 chars (verified live 2026-09-25: 24-hex ids → 403). Both the
// stable (per-user/per-model) and random (per-request) generators below emit
// that exact shape; `msg_*` request ids use the same shape (gateway accepts
// any value there today, but uniformity is future-proof).
const BASE62_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Gateway-valid session id shape: `ses_` + 12 lowercase hex + 14 base62. */
export const OPENCODE_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

function base62FromBytes(bytes, length) {
  let out = "";
  for (let i = 0; out.length < length; i++) {
    const b = bytes[i % bytes.length];
    out += BASE62_ALPHABET[(b + i * 31) % 62];
  }
  return out;
}

function opencodeId(prefix, seedBytes) {
  const hex12 = Buffer.from(seedBytes.subarray(0, 6)).toString("hex");
  const b62 = base62FromBytes(seedBytes.subarray(6), 14);
  return `${prefix}_${hex12}${b62}`;
}

function randomId(prefix) {
  return opencodeId(prefix, randomBytes(20));
}

/**
 * Derive a stable `ses_*` id from a seed (credential + model) so the Zen
 * gateway's sticky provider selection + prompt-cache affinity keep working
 * when the downstream client (e.g. `@ai-sdk/openai-compatible`) sends no
 * `x-opencode-session` of its own. A fresh random id per request — the old
 * behavior — disables stickiness entirely and spreads one user's traffic
 * across upstream providers, raising the odds of hitting an unhealthy one
 * (surfaced as transport `terminated`). The seed is SHA-256 hashed: the raw
 * key never leaves this function in recoverable form.
 */
export function stableSessionId(seed) {
  const digest = createHash("sha256").update(String(seed ?? "")).digest();
  return opencodeId("ses", digest);
}
function findHeader(headers, name) {
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

/**
 * Extract a per-caller seed from downstream headers (the caller's own API
 * key). Used ONLY as hash input for a stable `x-opencode-session` — the raw
 * value is never logged, never forwarded upstream, and never leaves this
 * module except inside a SHA-256 digest. Returns null when absent.
 */
export function extractCallerSeed(clientHeaders) {
  if (!clientHeaders || typeof clientHeaders !== "object") return null;
  try {
    // `authorization` covers Bearer clients; `x-api-key` covers Anthropic-style
    // harnesses (e.g. Claude Code) so each downstream caller still gets an
    // isolated session instead of sharing one global seed.
    const auth = findHeader(clientHeaders, "authorization") || findHeader(clientHeaders, "x-api-key");
    if (typeof auth === "string" && auth.trim() !== "") return auth.trim();
  } catch {
    // Malformed headers object — no per-caller seed.
  }
  return null;
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
 *   missing (only when the value already matches the gateway-valid `ses_*`
 *   shape), and synthesizes a gate-format id for x-opencode-request if also
 *   missing.
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

  // 3. OpencodeExecutor-only: synthesize session/request id from fallback headers.
  // Only adopt the affinity value when it already looks like a gateway-valid
  // `ses_*` id — a foreign shape (e.g. a UUID from another harness) would be
  // rejected by the Console gate with 403, so fall through to the generated
  // fingerprint below instead.
  if (options?.synthesizeRequestId && !headers["x-opencode-session"]) {
    const sessionAffinity = findHeader(clientHeaders, "x-session-affinity") || findHeader(clientHeaders, "x-session-id");
    if (sessionAffinity && OPENCODE_SESSION_RE.test(sessionAffinity)) {
      headers["x-opencode-session"] = sessionAffinity;
      if (!headers["x-opencode-request"]) {
        headers["x-opencode-request"] = randomId("msg");
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
 *   synthesizes `msg_*` per request when absent.
 * - `x-opencode-session`: when the client sent none and `stableSeed` is
 *   provided, derives a stable per-user/per-model id (sticky routing + prompt
 *   cache affinity, like the official CLI's per-session id). Falls back to a
 *   per-request random id when no seed is available.
 * - No-op when `OMNIROUTE_OPENCODE_FAKE_HEADERS=0/false/off/no`.
 *
 * Must run AFTER `forwardOpencodeClientHeaders()` and BEFORE
 * `stripStainlessHeadersForOpenAICompat()` (the strip only normalizes UAs
 * containing "openai", so the fake `opencode/...` UA survives it).
 */
export function applyOpencodeFakeFingerprint(headers, clientHeaders = null, stableSeed = null) {
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
  // x-opencode-session: prefer the client's real session; otherwise a stable
  // per-user/per-model id so Zen sticky routing keeps working.
  if (!headers["x-opencode-session"]) {
    headers["x-opencode-session"] = stableSeed != null && stableSeed !== ""
      ? stableSessionId(stableSeed)
      : randomId("ses");
  }
  // x-opencode-request (per-request random when absent — matches CLI's msg_*).
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