import { BaseExecutor } from "./base";
import { PROVIDERS } from "../config/constants";
import { getModelTargetFormat } from "../config/providerModels";
import { injectReasoningContentForThinkingModel, isThinkingMessageModel } from "../utils/reasoningContentInjector";
import { runWithProxyContext } from "../utils/proxyFetch";
import { forwardOpencodeClientHeaders, applyOpencodeFakeFingerprint, extractCallerSeed } from "../utils/opencodeHeaders";

/**
 * Per-account proxy configuration, persisted by NoAuthAccountCard under
 * `providerSpecificData.accountProxies` (keyed by the account id, which the UI
 * stores in `providerSpecificData.fingerprints`). Same shape mimocode uses.
 */

/** Runtime rotation/cooldown state for one "OpenCode Free" account. */

const OPENCODE_COOLDOWN_BASE_MS = 5_000;
const OPENCODE_COOLDOWN_MAX_MS = 60_000;
// Retry policy modeled after the official Opencode client
// (packages/opencode/src/session/retry.ts): full-request retry with
// `2s * 2^(n-1) + 25% jitter`, capped at 30s without server headers, always
// honoring `retry-after`. Bounded to 2 attempts per account so N accounts
// yield at most N*2 upstream calls — no unbounded DDoS on the Zen gateway.
const OPENCODE_RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 524]);
const OPENCODE_MAX_ATTEMPTS_PER_ACCOUNT = 2;
const OPENCODE_RETRY_INITIAL_DELAY_MS = 2_000;
const OPENCODE_RETRY_MAX_DELAY_NO_HEADERS_MS = 30_000;
const OPENCODE_RETRY_MAX_DELAY_MS = 2_147_483_647;
const EFFORT_LEVELS = ["low", "medium", "high", "max"];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Retry-wait pacing: long upstream `retry-after` values (Zen daily quotas can
// ask for hours) must not hold one downstream connection in a single giant
// sleep — the downstream client times out first and the wait burns anyway.
// Waits are sliced (default 30s) so caller aborts are noticed promptly and
// progress is visible in logs; a per-request budget (default 240s) caps total
// pre-response waiting, after which the last upstream result is surfaced.
const OPENCODE_RETRY_SLICE_MS_DEFAULT = 30_000;
const OPENCODE_RETRY_BUDGET_MS_DEFAULT = 240_000;

function envBoundedMs(name, def, min, max, env = process.env) {
  const raw = env?.[name];
  if (raw == null || String(raw).trim() === "") return def;
  const parsed = Number(String(raw).trim());
  if (!Number.isFinite(parsed)) return def;
  return Math.min(Math.max(Math.floor(parsed), min), max);
}

function getRetrySliceMs(env) {
  return envBoundedMs("OMNIROUTE_OPENCODE_RETRY_SLICE_MS", OPENCODE_RETRY_SLICE_MS_DEFAULT, 1_000, 60_000, env);
}

function getRetryBudgetMs(env) {
  return envBoundedMs("OMNIROUTE_OPENCODE_RETRY_BUDGET_MS", OPENCODE_RETRY_BUDGET_MS_DEFAULT, 0, 600_000, env);
}

function throwIfDownstreamAborted(signal) {
  if (signal?.aborted) {
    const abortErr = new Error("Downstream caller aborted while waiting to retry upstream");
    abortErr.name = "AbortError";
    throw abortErr;
  }
}

async function sleepAbortable(totalMs, { signal, log, masked, purpose }) {
  const sliceMs = getRetrySliceMs();
  // Herd stagger, applied once per wait (not per slice): concurrent waiters on
  // the same exhausted bucket wake desynced instead of 429ing each other in
  // lockstep. Capped so short backoffs stay close to the Opencode timing.
  const staggerMs = Math.floor(Math.random() * Math.min(2000, Math.max(250, totalMs * 0.25)));
  const plannedMs = totalMs + staggerMs;
  let waited = 0;
  let progressLogged = false;
  while (waited < plannedMs) {
    throwIfDownstreamAborted(signal);
    const chunk = Math.min(sliceMs, plannedMs - waited);
    await sleep(chunk);
    waited += chunk;
    if (waited < plannedMs && !progressLogged && plannedMs > sliceMs) {
      progressLogged = true;
      log?.info?.("OPENCODE", `Still waiting on account ${masked} (${Math.round(waited / 1000)}s/~${Math.round(plannedMs / 1000)}s, ${purpose})…`);
    }
  }
}

/**
 * Opencode-style backoff: `2s * 2^(attempt-1) + 25% jitter`, honoring the
 * upstream `retry-after(-ms)` header when present.
 */
function computeOpencodeBackoffMs(attempt, retryAfterMs) {
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return Math.min(Math.ceil(retryAfterMs), OPENCODE_RETRY_MAX_DELAY_MS);
  }
  const base = OPENCODE_RETRY_INITIAL_DELAY_MS * Math.pow(2, attempt - 1);
  return Math.min(Math.ceil(base + base * 0.25 * Math.random()), OPENCODE_RETRY_MAX_DELAY_NO_HEADERS_MS);
}

function parseRetryAfterMs(response) {
  try {
    const headers = response?.headers;
    const get = typeof headers?.get === "function"
      ? name => headers.get(name)
      : headers
        ? name => headers[name] ?? headers[name.toLowerCase()]
        : () => null;
    const afterMs = Number.parseFloat(get("retry-after-ms"));
    if (Number.isFinite(afterMs) && afterMs > 0) return afterMs;
    const after = get("retry-after");
    if (after != null && after !== "") {
      const seconds = Number.parseFloat(after);
      if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
      const dateMs = Date.parse(after) - Date.now();
      if (Number.isFinite(dateMs) && dateMs > 0) return Math.ceil(dateMs);
    }
  } catch {
    // Malformed headers — fall back to exponential backoff.
  }
  return NaN;
}

const RETRYABLE_TRANSPORT_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "ENETUNREACH", "EHOSTUNREACH"]);

/**
 * Whether a fetch-phase throw is worth retrying (possibly on the next
 * account). Mirrors `isRetryableStreamError` (services/streamRecovery.js) plus
 * the official client's patterns (session/retry.ts): socket resets, undici
 * `terminated`, timeouts. Client-initiated aborts must NEVER be retried —
 * replaying a request the caller walked away from is incorrect.
 */
function isRetryableTransportError(error) {
  if (!error || typeof error !== "object") return false;
  const name = error.name;
  if (name === "AbortError" || name === "ResponseAborted") return false;
  if (name === "TimeoutError" || name === "BodyTimeoutError") return true;
  const code = error.code;
  if (typeof code === "string") {
    if (RETRYABLE_TRANSPORT_CODES.has(code)) return true;
    if (code.startsWith("UND_ERR_")) return true;
  }
  const message = error.message;
  if (typeof message === "string" && /terminated|socket hang up|fetch failed|failed to fetch|network[\s_-]?error|connection (refused|lost|reset|error)|econnreset|econnrefused|etimedout|enotfound/i.test(message)) {
    return true;
  }
  return false;
}

/**
 * Parse a DeepSeek V4 Pro model string with an effort-level suffix.
 * e.g. "deepseek-v4-pro-low" → { baseModel: "deepseek-v4-pro", effort: "low" }
 * Returns null if the model doesn't match the pattern.
 */
function parseDeepSeekEffortLevel(model) {
  const m = String(model || "");
  const matchedLevel = EFFORT_LEVELS.find(level => m.endsWith(`-${level}`));
  if (!matchedLevel) return null;
  const baseModel = m.slice(0, -matchedLevel.length - 1);
  if (baseModel.toLowerCase() !== "deepseek-v4-pro") return null;
  return {
    baseModel: "deepseek-v4-pro",
    effort: matchedLevel
  };
}
export class OpencodeExecutor extends BaseExecutor {
  _requestFormat = null;

  /**
   * Per-account rotation state, rebuilt from credentials on each request. The
   * default entry (fingerprint "") represents the single anonymous account with
   * no configured proxy — preserves the historical direct pass-through when the
   * user has not configured any per-account proxy.
   */
  accounts = [{
    fingerprint: "",
    cooldownUntil: 0,
    consecutiveFails: 0,
    proxy: null
  }];
  nextAccountIdx = 0;
  constructor(provider) {
    super(provider, PROVIDERS[provider] || PROVIDERS.openai);
  }

  /**
   * Rebuild `accounts` from `providerSpecificData.fingerprints` +
   * `providerSpecificData.accountProxies`. Each configured account id becomes a
   * rotation slot carrying its own proxy. When the user configured no accounts
   * at all, the single default direct account is kept (backward compatible).
   */
  syncAccountsFromCredentials(credentials) {
    const psd = credentials?.providerSpecificData;
    const fingerprints = Array.isArray(psd?.fingerprints) ? psd.fingerprints.filter(f => typeof f === "string") : [];
    const accountProxies = psd?.accountProxies;
    const proxyMap = Array.isArray(accountProxies) ? new Map(accountProxies.map(ap => [ap.fingerprint, ap.proxy ?? null])) : null;
    if (fingerprints.length === 0) {
      // No configured accounts — keep a single direct account.
      this.accounts = [{
        fingerprint: "",
        cooldownUntil: 0,
        consecutiveFails: 0,
        proxy: null
      }];
      this.nextAccountIdx = 0;
      return;
    }
    const previous = new Map(this.accounts.map(a => [a.fingerprint, a]));
    this.accounts = fingerprints.map(fp => {
      const prior = previous.get(fp);
      return {
        fingerprint: fp,
        cooldownUntil: prior?.cooldownUntil ?? 0,
        consecutiveFails: prior?.consecutiveFails ?? 0,
        proxy: proxyMap ? proxyMap.get(fp) ?? null : null
      };
    });
    if (this.nextAccountIdx >= this.accounts.length) this.nextAccountIdx = 0;
  }
  isAccountReady(account) {
    return account.cooldownUntil <= Date.now();
  }

  /** Round-robin pick, skipping accounts in cooldown; falls back to the next index. */
  pickAccount() {
    for (let i = 0; i < this.accounts.length; i++) {
      const idx = (this.nextAccountIdx + i) % this.accounts.length;
      const acct = this.accounts[idx];
      if (this.isAccountReady(acct)) {
        this.nextAccountIdx = (idx + 1) % this.accounts.length;
        return acct;
      }
    }
    const fallbackIdx = this.nextAccountIdx % this.accounts.length;
    this.nextAccountIdx = (this.nextAccountIdx + 1) % this.accounts.length;
    return this.accounts[fallbackIdx];
  }
  markCooldown(account) {
    account.consecutiveFails++;
    const backoff = Math.min(OPENCODE_COOLDOWN_BASE_MS * Math.pow(2, account.consecutiveFails - 1), OPENCODE_COOLDOWN_MAX_MS);
    account.cooldownUntil = Date.now() + backoff + Math.random() * 1000;
  }
  markSuccess(account) {
    account.consecutiveFails = 0;
  }

  /** Mask an account id for logs (UI calls it a fingerprint). */
  static maskAccountId(fingerprint) {
    if (!fingerprint) return "direct";
    return `${fingerprint.slice(0, 8)}…`;
  }
  async execute(input) {
    this._requestFormat = getModelTargetFormat(this.provider, input.model) || "openai";
    try {
      this.syncAccountsFromCredentials(input.credentials);
      const {
        log
      } = input;
      const totalAccounts = this.accounts.length;
      let lastResult = null;
      let lastError = null;
      const retryBudget = { leftMs: getRetryBudgetMs() };
      // Wait `waitMs` in abort-aware slices. Returns true when the full wait
      // elapsed (caller should continue retrying), false when the per-request
      // budget ran out (caller should surface the last upstream result).
      // Throws AbortError when the downstream caller walked away mid-wait.
      const waitForRetry = async (waitMs, purpose, masked) => {
        const allowed = Math.max(0, Math.min(waitMs, retryBudget.leftMs));
        if (allowed <= 0) {
          log?.warn?.("OPENCODE", `Retry budget exhausted — surfacing last upstream result instead of waiting ${Math.ceil(waitMs / 1000)}s (${purpose}).`);
          return false;
        }
        if (allowed < waitMs) {
          log?.warn?.("OPENCODE", `Retry budget covers only ${Math.ceil(allowed / 1000)}s of ${Math.ceil(waitMs / 1000)}s asked (${purpose}) — waiting what fits, then surfacing.`);
        }
        await sleepAbortable(allowed, { signal: input.signal, log, masked, purpose });
        retryBudget.leftMs -= allowed;
        return allowed >= waitMs;
      };
      for (let accountIdx = 0; accountIdx < totalAccounts; accountIdx++) {
        const account = this.pickAccount();
        const masked = OpencodeExecutor.maskAccountId(account.fingerprint);
        // #5217 (Gap 2): promoted debug→info so the per-request account/proxy
        // rotation selection is visible in the Console log view at the default
        // APP_LOG_LEVEL=info (users could not see which account/proxy was used).
        // Token stays masked — never log the full account id.
        log?.info?.("OPENCODE", `dispatch via account ${masked} (idx ${accountIdx + 1}/${totalAccounts})` + (account.proxy ? ` through proxy ${account.proxy.host}:${account.proxy.port}` : " direct"));

        // Pin egress to this account's proxy for the whole BaseExecutor dispatch
        // (incl. its intra-URL 429 retries). skipUpstreamRetry lets THIS loop own
        // the cross-account fallback instead of BaseExecutor's same-key retry —
        // extended with Opencode-style transient retry (5xx + transport throws),
        // which BaseExecutor never retried (it only handles 429).
        for (let attempt = 1; attempt <= OPENCODE_MAX_ATTEMPTS_PER_ACCOUNT; attempt++) {
          let result;
          try {
            result = await runWithProxyContext(account.proxy, () => super.execute({
              ...input,
              skipUpstreamRetry: true
            }));
          } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            lastError = err;
            // Caller walked away (or non-transport bug) — never replay.
            if (!isRetryableTransportError(err) || input.signal?.aborted) throw err;
            if (attempt < OPENCODE_MAX_ATTEMPTS_PER_ACCOUNT) {
              const wait = computeOpencodeBackoffMs(attempt, NaN);
              log?.warn?.("OPENCODE", `Transport error on account ${masked} (attempt ${attempt}): ${err.message} — retrying in ${wait}ms…`);
              if (await waitForRetry(wait, `transport ${err.message}`, masked)) continue;
            }
            this.markCooldown(account);
            log?.warn?.("OPENCODE", `Transport error on account ${masked} persists (${err.message}), rotating to next…`);
            break;
          }
          const status = result.response.status;
          if (status === 429) {
            lastResult = result;
            // Prefer rotating to a fresh account; only backoff-retry in place
            // when this is the last account available (single-account setups
            // have nobody to rotate to — matching the client's retry policy).
            if (accountIdx < totalAccounts - 1) {
              this.markCooldown(account);
              log?.warn?.("OPENCODE", `Rate limited (429) on account ${masked}, rotating to next…`);
              break;
            }
            if (attempt < OPENCODE_MAX_ATTEMPTS_PER_ACCOUNT) {
              const wait = computeOpencodeBackoffMs(attempt, parseRetryAfterMs(result.response));
              log?.warn?.("OPENCODE", `Rate limited (429) on last account ${masked} — retrying in ${wait}ms…`);
              if (await waitForRetry(wait, "429 rate limit", masked)) continue;
            }
            this.markCooldown(account);
            break;
          }
          if (OPENCODE_RETRYABLE_STATUS.has(status)) {
            lastResult = result;
            if (attempt < OPENCODE_MAX_ATTEMPTS_PER_ACCOUNT) {
              const wait = computeOpencodeBackoffMs(attempt, parseRetryAfterMs(result.response));
              log?.warn?.("OPENCODE", `Transient ${status} on account ${masked} (attempt ${attempt}) — retrying in ${wait}ms…`);
              if (await waitForRetry(wait, `transient ${status}`, masked)) continue;
            }
            this.markCooldown(account);
            log?.warn?.("OPENCODE", `Transient ${status} on account ${masked} persists, rotating to next…`);
            break;
          }
          this.markSuccess(account);
          return result;
        }
      }

      // All accounts returned retryable statuses (or threw retryable transport
      // errors) — surface the last response so combo/fallback layers can act on
      // the real status instead of a masked exception.
      if (lastResult) return lastResult;
      if (lastError) throw lastError;
      return await super.execute(input);
    } finally {
      this._requestFormat = null;
    }
  }
  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    void urlIndex;
    void credentials;
    const base = this.config.baseUrl;
    switch (this._requestFormat) {
      case "claude":
        return `${base}/messages`;
      case "openai-responses":
        return `${base}/responses`;
      case "gemini":
        return `${base}/models/${model}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
      default:
        return `${base}/chat/completions`;
    }
  }
  buildHeaders(credentials, stream = true, clientHeaders, model) {
    const headers = {
      "Content-Type": "application/json"
    };
    const key = credentials?.apiKey || credentials?.accessToken;
    if (key) {
      if (this._requestFormat === "claude") {
        headers["x-api-key"] = key;
      } else {
        headers["Authorization"] = `Bearer ${key}`;
      }
    }
    if (this._requestFormat === "claude") {
      headers["anthropic-version"] = "2023-06-01";
    }
    if (stream) {
      headers["Accept"] = "text/event-stream";
    }
    if (clientHeaders) {
      forwardOpencodeClientHeaders(headers, clientHeaders, {
        synthesizeRequestId: true
      });
    }
    // Zen free tier is UA-gated: spoof official CLI identity so
    // `*-free` / muse-spark / nemotron models aren't rejected with
    // "OpenCode's free tier can only be used in OpenCode".
    // Session precedence: real client session (forwarded above) wins; else a
    // stable per-DOWNSTREAM-user id (hashed, never the raw key) so Zen sticky
    // routing + prompt-cache affinity isolate users instead of pinning
    // everyone onto one shared session; else the upstream credential seed.
    const callerSeed = extractCallerSeed(clientHeaders);
    const upstreamKey = credentials?.apiKey || credentials?.accessToken;
    const sessionSeed = callerSeed != null && callerSeed !== ""
      ? `${callerSeed}:${model || ""}`
      : (upstreamKey
        ? `${upstreamKey}:${model || ""}`
        : (credentials?.connectionId ? `${credentials.connectionId}:${model || ""}` : null));
    applyOpencodeFakeFingerprint(headers, clientHeaders || null, sessionSeed);
    return headers;
  }
  transformRequest(model, body, stream, credentials) {
    let modifiedBody = super.transformRequest(model, body, stream, credentials);
    if (modifiedBody && typeof modifiedBody === "object" && Array.isArray(modifiedBody.tools) && modifiedBody.tools.length > 128) {
      modifiedBody.tools = modifiedBody.tools.slice(0, 128);
    }
    if (modifiedBody && typeof modifiedBody === "object" && !Array.isArray(modifiedBody)) {
      const mb = modifiedBody;
      const parsed = parseDeepSeekEffortLevel(model);
      if (parsed) {
        mb.model = parsed.baseModel;
        if (mb.reasoning_effort === undefined) {
          mb.reasoning_effort = parsed.effort;
        }
      }
    }
    // #1543 / upstream PR #1099: thinking-mode upstreams routed through OpenCode
    // (DeepSeek V4 Flash, Kimi, MiniMax, ...) require reasoning_content echoed
    // back on assistant messages, or they 400 with "reasoning_content must be
    // passed back". OpenAI clients drop it across turns, so we inject a
    // placeholder for the affected model families.
    if (isThinkingMessageModel(model)) {
      modifiedBody = injectReasoningContentForThinkingModel(modifiedBody);
    }
    return modifiedBody;
  }
}