import { HTTP_STATUS, FETCH_TIMEOUT_MS } from "../config/constants";
import { mergeClientAnthropicBeta, normalizeAnthropicHeaderVariants } from "../config/anthropicHeaders";
import { applyContextEditingToBody } from "../config/contextEditing";
import { findOffendingField, stripGroqUnsupportedFields } from "../config/providerFieldStrips";
import { applyFingerprint, isCliCompatEnabled } from "../config/cliFingerprints";
import { supportsClaudeMaxEffort, supportsXHighEffort } from "../config/providerModels";
import { getThinkingBudgetConfig, ThinkingMode } from "../services/thinkingBudget";
import { SessionPool } from "../services/sessionPool/sessionPool";
import { PoolRegistry } from "../services/sessionPool/poolRegistry";
import { resolveKeyForRequest } from "../services/apiKeyRotator";
import { getOpenAICompatibleType, isClaudeCodeCompatible } from "../services/provider";
import { runWithOnPersist, getRefreshLeadMs, isUnrecoverableRefreshError } from "../services/tokenRefresh";
import { signRequestBody } from "../services/claudeCodeCCH";
import { appendAnthropicBetaHeader, CONTEXT_1M_BETA_HEADER, enforceThinkingTemperature, modelSupportsContext1mBeta } from "../services/claudeCodeCompatible";
import { getClaudeCodeCompatibleRequestDefaults } from "../stubs/lib/providers/requestDefaults";
import { cloakThirdPartyToolNames, remapToolNamesInRequest } from "../services/claudeCodeToolRemapper";
import { obfuscateInBody } from "../services/claudeCodeObfuscation";
import { sanitizeClaudeToolSchemas } from "../translator/helpers/schemaCoercion";
import { sanitizeResponsesInputItems } from "../services/responsesInputSanitizer";
import { applySystemTransformPipeline, PROVIDER_CLAUDE } from "../services/systemTransforms";
import * as prl from "../utils/providerRequestLogging";
import { fixToolPairs, fixToolAdjacency, stripTrailingAssistantOrphanToolUse, stripTrailingAssistantForProvider } from "../services/contextManager";
import { randomUUID } from "node:crypto";
import { CLAUDE_CODE_VERSION, CLAUDE_CODE_STAINLESS_VERSION, buildHashFor, buildUserIdJson, getSessionId, parseUpstreamMetadataUserId, passthroughUpstreamSessionId, resolveAccountUUID, resolveCliUserID, selectBetaFlags, stainlessArch, stainlessOS, stainlessRuntimeVersion, stripProxyToolPrefix } from "./claudeIdentity";
import { withForcedResponsesUpstream } from "./forceResponsesUpstream";

/**
 * Sanitizes a custom API path to prevent path traversal attacks.
 * Valid paths must start with '/', contain no '..' segments,
 * no null bytes, and be reasonable in length.
 */
function sanitizePath(path) {
  if (typeof path !== "string") return false;
  if (!path.startsWith("/")) return false;
  if (path.includes("\0")) return false; // null byte
  if (path.includes("..")) return false; // path traversal
  if (path.length > 512) return false; // sanity limit
  return true;
}
/** Apply model-level extra upstream headers (e.g. Authentication, X-Custom-Auth). */
export function mergeUpstreamExtraHeaders(headers, extra) {
  if (!extra) return;
  for (const [k, v] of Object.entries(extra)) {
    if (typeof k === "string" && k.length > 0 && typeof v === "string") {
      if (k.toLowerCase() === "user-agent") {
        setUserAgentHeader(headers, v);
        continue;
      }
      headers[k] = v;
    }
  }
}
export function getCustomUserAgent(providerSpecificData) {
  const customUserAgent = typeof providerSpecificData?.customUserAgent === "string" ? providerSpecificData.customUserAgent.trim() : "";
  return customUserAgent || null;
}
export function setUserAgentHeader(headers, userAgent) {
  headers["User-Agent"] = userAgent;
  if ("user-agent" in headers) {
    headers["user-agent"] = userAgent;
  }
}
export function applyConfiguredUserAgent(headers, providerSpecificData) {
  const customUserAgent = getCustomUserAgent(providerSpecificData);
  if (customUserAgent) {
    setUserAgentHeader(headers, customUserAgent);
  }
}

/**
 * Returns true when the outbound request targets an OpenAI-compatible endpoint
 * (a `openai-compatible-*` provider, or a Chat Completions / Responses URL).
 * Used to scope the X-Stainless strip narrowly so genuine SDK-spoofing paths
 * (e.g. Claude Code compat, which legitimately ADDS X-Stainless-*) are untouched.
 */
export function isOpenAICompatibleEndpoint(provider, url) {
  if (provider?.startsWith?.("openai-compatible-")) return true;
  return url.includes("/v1/chat/completions") || url.includes("/v1/responses");
}

/**
 * Strip OpenAI SDK (`X-Stainless-*`) metadata headers and normalize an SDK-derived
 * User-Agent for OpenAI-compatible passthrough requests. Some upstream gateways
 * 403 on these SDK-identifying headers. Only applied to OpenAI-compatible endpoints —
 * other providers (Claude/Claude Code compat) may legitimately send X-Stainless-*.
 *
 * Mutates `headers` in place and returns the list of stripped header keys (for logging).
 */
export function stripStainlessHeadersForOpenAICompat(headers, provider, url) {
  if (!isOpenAICompatibleEndpoint(provider, url)) return [];
  const strippedKeys = [];
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase().startsWith("x-stainless-")) {
      delete headers[key];
      strippedKeys.push(key);
    }
  }

  // Normalize User-Agent: SDK-based clients send verbose product strings that some
  // upstreams block. Replace with a clean browser-like UA only when it looks SDK-derived.
  const ua = (headers["User-Agent"] || headers["user-agent"] || "").toLowerCase();
  if (ua.includes("openai") && (ua.includes("node") || ua.includes("axios") || ua.includes("undici"))) {
    setUserAgentHeader(headers, "Mozilla/5.0 (compatible; OpenAI Compatible)");
  }
  return strippedKeys;
}
export function mergeAbortSignals(primary, secondary) {
  const controller = new AbortController();
  const abortFrom = source => {
    if (!controller.signal.aborted) {
      controller.abort(source.reason);
    }
  };
  if (primary.aborted) {
    abortFrom(primary);
    return controller.signal;
  }
  if (secondary.aborted) {
    abortFrom(secondary);
    return controller.signal;
  }
  primary.addEventListener("abort", () => abortFrom(primary), {
    once: true
  });
  secondary.addEventListener("abort", () => abortFrom(secondary), {
    once: true
  });
  return controller.signal;
}
function hasActiveClaudeThinking(body) {
  const thinking = body.thinking;
  return thinking?.type === "enabled" || thinking?.type === "adaptive";
}

/**
 * Sanitize reasoning_effort for providers that don't accept all values.
 *
 * The claude→openai translator may emit reasoning_effort=max/xhigh when the
 * client sends output_config.effort=max on a Claude-shape request. Combined with
 * runtime alias remapping (e.g. claude-opus-4-6 → mimo/mimo-v2.5-pro), this
 * routes xhigh to OpenAI-shape providers that don't accept the value:
 *
 *   xiaomi-mimo : low|medium|high only — 400 literal_error on xhigh
 *   mistral     : devstral models reject reasoning_effort entirely
 *   github      : claude/haiku/oswe models reject reasoning_effort entirely
 *
 * Each rejection burns a combo fallback attempt before reaching a working
 * provider. Apply provider-aware sanitation here (after transformRequest, so
 * reintroductions by per-provider transforms are also caught) before fetch.
 * xhigh support is opt-out: pass through unchanged unless the registry marks
 * a model as unsupported. Literal max support is provider-specific and
 * intentionally separate: some upstreams accept max even when they do not
 * accept xhigh. For OpenAI-shape providers, max normalizes to xhigh by default
 * and falls back to high only for explicit xhigh opt-outs.
 */
const MISTRAL_NO_REASONING_EFFORT_PATTERN = /devstral/i;
// GitHub Copilot Claude routing is granular (upstream port: decolua/9router#791):
//   ✅ Pass through — Claude Opus 4.6, Claude Sonnet 4.6. Copilot routes both to
//      Anthropic's chat/completions surface, which honors reasoning_effort and
//      emits visible reasoning tokens (verified upstream: 3× token increase
//      between low/medium/high).
//   ❌ Strip — Claude Haiku 4.5 and Claude Opus 4.7 (rejected upstream by
//      Copilot's Claude backend), older Claude variants, all `haiku`-named
//      models, and the `oswe-*` family (Raptor) which still rejects
//      reasoning_effort.
// Order matters: the opt-in check must run BEFORE the broad Claude/haiku/oswe strip.
const GITHUB_REASONING_EFFORT_OPT_IN_PATTERN = /claude[-_.]?(?:opus|sonnet)[-_.]?4[-_.]6/i;
const GITHUB_NO_REASONING_EFFORT_PATTERN = /(claude|haiku|oswe)/i;
function supportsMaxEffortForProvider(provider, model) {
  const isClaude = (provider === PROVIDER_CLAUDE || isClaudeCodeCompatible(provider)) && supportsClaudeMaxEffort(model);
  // opencode-go proxies DeepSeek with the native DeepSeek API contract, which
  // accepts {high, max} literally. Without this opt-in, max would be
  // normalized to xhigh (the OmniRoute-internal top tier) and rejected by the
  // upstream. Scoped to opencode-go deliberately: OpenRouter's DeepSeek path
  // (pi#4055) is the documented inverse and expects xhigh, not max.
  // Ollama Cloud also accepts literal max (for example GLM 5.2 supports
  // low|medium|high|max|none) and rejects xhigh.
  const isOpencodeGoDeepSeek = provider === "opencode-go" && model.toLowerCase().includes("deepseek");
  const isOllamaCloud = provider === "ollama-cloud";
  return isClaude || isOpencodeGoDeepSeek || isOllamaCloud;
}
export function sanitizeReasoningEffortForProvider(body, provider, model, log) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const b = body;
  const reasoning = b.reasoning && typeof b.reasoning === "object" && !Array.isArray(b.reasoning) ? b.reasoning : null;
  const hasTopLevelReasoningEffort = Object.prototype.hasOwnProperty.call(b, "reasoning_effort");
  const effort = b.reasoning_effort ?? reasoning?.effort;
  if (effort === undefined) return body;
  const effortStr = typeof effort === "string" ? effort.toLowerCase() : "";
  const modelStr = model || "";
  const githubOptIn = provider === "github" && GITHUB_REASONING_EFFORT_OPT_IN_PATTERN.test(modelStr);
  const rejecting = provider === "mistral" && MISTRAL_NO_REASONING_EFFORT_PATTERN.test(modelStr) || provider === "github" && !githubOptIn && GITHUB_NO_REASONING_EFFORT_PATTERN.test(modelStr);
  if (rejecting) {
    log?.info?.("REASONING_SANITIZE", `${provider}/${modelStr}: removed unsupported reasoning_effort`);
    const next = {
      ...b
    };
    delete next.reasoning_effort;
    if (reasoning) {
      const r = {
        ...reasoning
      };
      delete r.effort;
      if (Object.keys(r).length === 0) delete next.reasoning;else next.reasoning = r;
    }
    return next;
  }

  // Native DeepSeek (api.deepseek.com) — V4 thinking mode accepts reasoning_effort
  // ONLY as {high, max} (its own top tier is literally "max"). OmniRoute's internal
  // scale is low|medium|high|xhigh where xhigh is the top, so map onto DeepSeek's
  // vocabulary: xhigh → max (top→top), low|medium → high (below the enum floor).
  // high/max pass through unchanged. Without this, the claude→openai translator's
  // xhigh (and max-normalized-to-xhigh below) reaches DeepSeek as an unknown value,
  // silently dropping the client's requested effort. This is the INVERSE of the
  // OpenRouter-DeepSeek path, whose normalized API expects xhigh, not max (pi#4055).
  if (provider === "deepseek") {
    const mapped = effortStr === "xhigh" ? "max" : effortStr === "low" || effortStr === "medium" ? "high" : null;
    if (mapped && mapped !== effortStr) {
      log?.info?.("REASONING_SANITIZE", `deepseek/${modelStr}: normalized reasoning_effort ${effortStr} → ${mapped}`);
      const next = {
        ...b
      };
      if (hasTopLevelReasoningEffort) next.reasoning_effort = mapped;
      if (reasoning) next.reasoning = {
        ...reasoning,
        effort: mapped
      };
      return next;
    }
    return body;
  }
  const supportsXHigh = supportsXHighEffort(provider, modelStr);
  const shouldDowngradeXHigh = effortStr === "xhigh" && !supportsXHigh;
  const supportsXHighForMax = supportsXHigh;
  const supportsMax = supportsMaxEffortForProvider(provider, modelStr);
  const shouldNormalizeMaxToXHigh = effortStr === "max" && !supportsMax && supportsXHighForMax;
  const shouldDowngradeMax = effortStr === "max" && !supportsMax && !supportsXHighForMax;
  if (shouldNormalizeMaxToXHigh) {
    log?.info?.("REASONING_SANITIZE", `${provider}/${modelStr}: normalized reasoning_effort max → xhigh`);
    const next = {
      ...b
    };
    if (hasTopLevelReasoningEffort) {
      next.reasoning_effort = "xhigh";
    }
    if (reasoning) {
      next.reasoning = {
        ...reasoning,
        effort: "xhigh"
      };
    }
    return next;
  }
  if (shouldDowngradeXHigh || shouldDowngradeMax) {
    log?.info?.("REASONING_SANITIZE", `${provider}/${modelStr}: downgraded reasoning_effort ${effortStr} → high`);
    const next = {
      ...b
    };
    if (hasTopLevelReasoningEffort) {
      next.reasoning_effort = "high";
    }
    if (reasoning) {
      next.reasoning = {
        ...reasoning,
        effort: "high"
      };
    }
    return next;
  }
  return body;
}

/**
 * Strip the OmniRoute provider prefix from versioned built-in tool model
 * fields (e.g. `cc/claude-opus-4-8` → `claude-opus-4-8`). Versioned built-in
 * tool types carry an 8-digit date suffix (`advisor_20260301`, `bash_20250124`);
 * the real Claude CLI sends a bare model id there, never a prefixed one, so a
 * leaked OmniRoute prefix makes Anthropic reject the request. Mutates in place.
 */
export function stripVersionedToolModelPrefix(tools) {
  if (!Array.isArray(tools)) return;
  for (const t of tools) {
    if (typeof t.type === "string" && /^[a-z][a-z0-9_]*_\d{8}$/.test(t.type) && typeof t.model === "string" && t.model.includes("/")) {
      t.model = t.model.split("/").pop();
    }
  }
}

/**
 * BaseExecutor - Base class for provider executors.
 * Implements the Strategy pattern: subclasses override specific methods
 * (buildUrl, buildHeaders, transformRequest, etc.) for each provider.
 */
export class BaseExecutor {
  provider;
  config;

  // Session pool support — subclasses can set poolConfig to opt in
  poolConfig;
  _pool = null;
  constructor(provider, config) {
    this.provider = provider;
    this.config = config;
  }
  getProvider() {
    return this.provider;
  }
  getPool() {
    if (!this.poolConfig) return null;
    if (!this._pool) {
      const pool = new SessionPool(this.provider, this.poolConfig);
      pool.warmUp(this.poolConfig.minSessions).catch(() => {});
      PoolRegistry.register(this.provider, pool);
      this._pool = pool;
    }
    return this._pool;
  }
  buildPoolHeaders(session) {
    if (!session) return {};
    return session.buildHeaders();
  }
  getBaseUrls() {
    return this.config.baseUrls || (this.config.baseUrl ? [this.config.baseUrl] : []);
  }
  getFallbackCount() {
    return this.getBaseUrls().length || 1;
  }
  getTimeoutMs() {
    return 0; // Disabled: no upstream timeout
  }
  getCountTokensTimeoutMs() {
    return this.getTimeoutMs();
  }
  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    void model;
    void stream;
    if (this.provider?.startsWith?.("openai-compatible-")) {
      const psd = credentials?.providerSpecificData;
      const baseUrl = typeof psd?.baseUrl === "string" ? psd.baseUrl : "https://api.openai.com/v1";
      const normalized = baseUrl.replace(/\/$/, "");
      // Sanitize custom path: must start with '/', no path traversal, no null bytes
      const rawPath = typeof psd?.chatPath === "string" && psd.chatPath ? psd.chatPath : null;
      const customPath = rawPath && sanitizePath(rawPath) ? rawPath : null;
      if (customPath) return `${normalized}${customPath}`;
      const path = getOpenAICompatibleType(this.provider, psd) === "responses" ? "/responses" : "/chat/completions";
      return `${normalized}${path}`;
    }
    const baseUrls = this.getBaseUrls();
    return baseUrls[urlIndex] || baseUrls[0] || this.config.baseUrl || "";
  }

  /**
   * Resolve the effective base URL for a request, preferring per-connection
   * providerSpecificData.baseUrl over the static provider config baseUrl.
   */
  resolveBaseUrl(credentials, fallback) {
    const psdBaseUrl = credentials?.providerSpecificData?.baseUrl;
    return (typeof psdBaseUrl === "string" ? psdBaseUrl : "") || fallback || this.config.baseUrl || "";
  }

  /**
   * Resolve the effective API key via extra-keys round-robin rotation.
   * Mutates `credentials.providerSpecificData.selectedKeyId` on rotation.
   */
  resolveEffectiveKey(credentials) {
    const extraKeys = credentials.providerSpecificData?.extraApiKeys ?? [];
    const selectedKeyId = credentials.providerSpecificData?.selectedKeyId;
    let effectiveKey = credentials.apiKey;
    if (extraKeys.length > 0 && credentials.connectionId && credentials.apiKey) {
      const resolved = resolveKeyForRequest(credentials.connectionId, credentials.apiKey, extraKeys, selectedKeyId ?? null);
      effectiveKey = resolved?.key ?? credentials.apiKey;
      if (resolved && credentials.providerSpecificData) {
        credentials.providerSpecificData.selectedKeyId = resolved.keyId;
      }
    }
    return effectiveKey;
  }

  /**
   * Build the common header preamble shared by BaseExecutor and DefaultExecutor:
   * Content-Type, config.headers, per-provider User-Agent env override, and
   * resolved effective key (via extra-keys round-robin).
   */
  buildHeadersPreamble(credentials, stream) {
    const headers = {
      "Content-Type": "application/json",
      ...this.config.headers
    };

    // Allow per-provider User-Agent override via environment variable.
    // Example: CLAUDE_USER_AGENT="my-agent/2.0" overrides the default for the Claude provider.
    const providerId = this.config?.id || this.provider;
    if (providerId) {
      const envKey = `${providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_USER_AGENT`;
      const envUA = process.env[envKey]?.trim();
      if (envUA) {
        setUserAgentHeader(headers, envUA);
      }
    }
    const effectiveKey = this.resolveEffectiveKey(credentials);
    void stream;
    return {
      headers,
      effectiveKey
    };
  }
  buildHeaders(credentials, stream = true, clientHeaders, model, health) {
    void clientHeaders;
    void model;
    const {
      headers,
      effectiveKey
    } = this.buildHeadersPreamble(credentials, stream);
    if (credentials.accessToken) {
      headers["Authorization"] = `Bearer ${credentials.accessToken}`;
    } else if (credentials.apiKey) {
      headers["Authorization"] = `Bearer ${effectiveKey}`;
    }
    headers["Accept"] = stream ? "text/event-stream" : "application/json";
    normalizeAnthropicHeaderVariants(headers);
    return headers;
  }

  // Override in subclass for provider-specific transformations
  transformRequest(model, body, stream, credentials) {
    void model;
    void stream;
    void credentials;

    // Fix #1674: Remove empty string values from optional parameters
    // like tool descriptions to avoid upstream validation failures.
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const cloned = {
        ...body
      };
      if (Array.isArray(cloned.input)) {
        cloned.input = sanitizeResponsesInputItems(cloned.input, false);
      }
      if (Array.isArray(cloned.tools)) {
        cloned.tools = cloned.tools.map(tool => {
          if (tool && typeof tool === "object" && !Array.isArray(tool)) {
            const toolRecord = tool;
            const toolFunction = toolRecord.function;
            if (toolFunction && typeof toolFunction === "object" && !Array.isArray(toolFunction)) {
              const func = {
                ...toolFunction
              };
              if (func.description === "") delete func.description;
              if (typeof func.name !== "string" || func.name.trim() === "") {
                func.name = "unnamed_tool";
              }
              return {
                ...toolRecord,
                function: func
              };
            }
          }
          return tool;
        });
      }

      // Fix #1884: Cursor sends prompt_cache_retention which breaks strict upstream endpoints
      delete cloned.prompt_cache_retention;

      // Also clean up top level optional fields that commonly cause issues when empty
      const optionalKeys = ["user", "stop", "seed", "response_format"];
      for (const key of optionalKeys) {
        if (cloned[key] === "") delete cloned[key];
      }
      return cloned;
    }
    return body;
  }
  shouldRetry(status, urlIndex) {
    return status === HTTP_STATUS.RATE_LIMITED && urlIndex + 1 < this.getFallbackCount();
  }

  // Intra-URL retry config: retry same URL before falling back to next node
  static RETRY_CONFIG = {
    maxAttempts: 2,
    delayMs: 2000
  };
  // Timeout for receiving the initial upstream response headers. Once the response
  // starts streaming, STREAM_IDLE_TIMEOUT_MS / Undici bodyTimeout handle stalls.
  static FETCH_START_TIMEOUT_MS = FETCH_TIMEOUT_MS;

  // Override in subclass for provider-specific refresh
  async refreshCredentials(credentials, log) {
    void credentials;
    void log;
    return null;
  }
  needsRefresh(credentials) {
    if (!credentials?.expiresAt) return false;
    const expiresAtMs = new Date(credentials.expiresAt).getTime();
    // Use the provider-specific lead time (REFRESH_LEAD_MS) so rotating-token
    // providers like Codex refresh proactively far ahead of expiry. Keeping the
    // refresh_token "warm" prevents Auth0 from marking it as stale and revoking
    // the token family on first use after long idle.
    const lead = getRefreshLeadMs(this.provider);
    return expiresAtMs - Date.now() < lead;
  }
  parseError(response, bodyText) {
    return {
      status: response.status,
      message: bodyText || `HTTP ${response.status}`
    };
  }
  buildCountTokensUrl(model, credentials = null) {
    void model;
    void credentials;
    const baseUrl = this.buildUrl(model, false, 0, credentials);
    if (typeof baseUrl !== "string" || baseUrl.length === 0) return null;
    if (this.config?.format !== "claude" || !baseUrl.includes("/messages")) return null;
    const [path, query = ""] = baseUrl.split("?");
    const normalizedPath = path.endsWith("/messages") ? `${path}/count_tokens` : `${path}/count_tokens`;
    return query ? `${normalizedPath}?${query}` : normalizedPath;
  }
  async countTokens({
    model,
    body,
    credentials,
    signal,
    log
  }) {
    const url = this.buildCountTokensUrl(model, credentials);
    if (!url) return null;
    const headers = this.buildHeaders(credentials, false);
    const requestBody = body && typeof body === "object" ? {
      ...body,
      model
    } : {
      model
    };
    let timeoutId = null;
    let activeSignal = signal || null;
    let controller = null;
    const timeoutMs = this.getCountTokensTimeoutMs();
    if (timeoutMs > 0) {
      controller = new AbortController();
      timeoutId = setTimeout(() => controller?.abort(), timeoutMs);
      activeSignal = signal ? mergeAbortSignals(signal, controller.signal) : controller.signal;
    }
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal: activeSignal || undefined
      });
      const text = await response.text();
      if (!response.ok) {
        const parsedError = this.parseError(response, text);
        throw new Error(parsedError.message);
      }
      const parsed = text ? JSON.parse(text) : {};
      const inputTokens = Number(parsed?.input_tokens);
      if (!Number.isFinite(inputTokens)) {
        throw new Error("Provider count_tokens response missing input_tokens");
      }
      return {
        input_tokens: inputTokens,
        provider: this.provider,
        source: "provider"
      };
    } catch (error) {
      log?.debug?.("COUNT_TOKENS", `${this.provider}/${model} real count unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }
  async execute(input) {
    const {
      model,
      body,
      stream,
      credentials,
      signal,
      log,
      extendedContext,
      upstreamExtraHeaders,
      clientHeaders,
      skipUpstreamRetry = false,
      onCredentialsRefreshed,
      contextEditing
    } = input;
    const fallbackCount = this.getFallbackCount();
    let lastError = null;
    let lastStatus = 0;
    let activeCredentials = credentials;
    // Track per-URL intra-retry attempts to avoid infinite loops
    const retryAttemptsByUrl = {};
    if (this.needsRefresh(credentials)) {
      try {
        // Fix A: wire onCredentialsRefreshed through runWithOnPersist so it runs
        // INSIDE the per-connection mutex inside getAccessToken. Not every
        // executor routes through getAccessToken (e.g. github.ts), so use a flag
        // to detect whether the persist callback actually fired and fall back to
        // post-refresh mutation when it didn't.
        let proactivePersistRan = false;
        const proactiveOnPersist = onCredentialsRefreshed ? async refreshResult => {
          proactivePersistRan = true;
          activeCredentials = {
            ...credentials,
            ...refreshResult
          };
          await onCredentialsRefreshed(refreshResult);
        } : null;
        const refreshed = await runWithOnPersist(proactiveOnPersist, () => this.refreshCredentials(credentials, log || null));
        if (refreshed && !proactivePersistRan) {
          // ─────────────────────────────────────────────────────────────────────
          // ⚠️ SOURCE OF TRUTH — do not flip the proactive path back to
          //    "persist expired+inactive". Ask the operator first.
          //
          // History (do not repeat past regressions):
          //   - ad3d4b696 (#2718, 2026-05-25): per-connection mutex + onPersist
          //     wiring so multi-account Codex (rotating refresh tokens) stops
          //     hitting refresh_token_reused under concurrent load.
          //   - 0c94c397d (#2743, 2026-05-26): a multi-agent review added a
          //     `await onCredentialsRefreshed({ testStatus: "expired",
          //     isActive: false })` here. That BROKE multi-account Codex —
          //     transient sentinels (refresh_token_reused recoverable via
          //     rotation map; generic invalid_request blips) were treated as
          //     terminal, so the proactive path sequentially disabled
          //     working accounts in the DB before any upstream call confirmed
          //     the failure. Reverted intentionally.
          //
          // Contract for the PROACTIVE refresh path:
          //   - Classify the sentinel ONLY to avoid spreading it into
          //     activeCredentials (which would send a non-token upstream).
          //   - DO NOT persist `{ testStatus: "expired", isActive: false }`
          //     from here. That decision belongs to the REACTIVE path in
          //     open-sse/handlers/chatCore.ts:~3912, which runs AFTER the
          //     upstream confirmed the auth failure. By then the rotation
          //     map (tokenRefresh.ts:~1541) and the DB-staleness check have
          //     already had their chance to recover the request.
          //
          // If a future review/agent thinks the expired-flip is "missing"
          // here, STOP — flipping it here re-introduces the multi-account
          // Codex regression. Discuss with the operator before touching.
          // ─────────────────────────────────────────────────────────────────────
          if (isUnrecoverableRefreshError(refreshed)) {
            const refreshCode = refreshed.code;
            log?.warn?.("TOKEN", `${this.provider.toUpperCase()} | proactive refresh returned unrecoverable sentinel (code=${String(refreshCode ?? "unknown")}); keeping stale credentials, deferring to reactive path.`);
            // Intentionally NOT spreading the sentinel and NOT persisting
            // expired status. The next upstream call either succeeds (rotation
            // map / DB-staleness saved us) or fails — chatCore.ts then marks
            // the account expired with confidence.
          } else {
            activeCredentials = {
              ...credentials,
              ...refreshed
            };
            if (onCredentialsRefreshed) {
              await onCredentialsRefreshed(refreshed);
            }
          }
        }
      } catch (error) {
        // tokenRefresh.ts:1352 documents that onPersist throws are re-thrown so
        // the caller is aware of the persistence failure. Honor that contract:
        // log at error level (not warn), with sanitized message — and let the
        // request continue with stale credentials so the user-visible error
        // surfaces upstream rather than being silently absorbed here.
        log?.error?.("TOKEN", `Credential refresh failed for ${this.provider}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Set by the Context Editing 400-fallback below: once an upstream rejects the
    // `context_management` param, suppress its re-injection on every later
    // retry/fallback URL (each iteration rebuilds a fresh `transformedBody`).
    let contextEditingDisabled = false;
    // Tracks which request fields have already been stripped via the generic 400
    // field-downgrade below, so each known field is stripped at most once across
    // all fallback URLs (bounded retry loop).
    const strippedFields = new Set();
    for (let urlIndex = 0; urlIndex < fallbackCount; urlIndex++) {
      const requestCredentials = withForcedResponsesUpstream(this.provider, body, activeCredentials);
      const url = this.buildUrl(model, stream, urlIndex, requestCredentials);
      const headers = this.buildHeaders(requestCredentials, stream, clientHeaders, model);
      applyConfiguredUserAgent(headers, requestCredentials?.providerSpecificData);

      // Strip OpenAI SDK (X-Stainless-*) metadata + normalize SDK-derived User-Agent
      // on OpenAI-compatible passthrough requests — some upstream gateways 403 on them.
      const strippedStainless = stripStainlessHeadersForOpenAICompat(headers, this.provider, url);
      if (strippedStainless.length > 0) {
        log?.debug?.("HEADERS", `Stripped X-Stainless-* from OpenAI-compatible request: ${strippedStainless.join(", ")}`);
      }
      const ccRequestDefaults = isClaudeCodeCompatible(this.provider) ? getClaudeCodeCompatibleRequestDefaults(requestCredentials?.providerSpecificData) : {};
      const shouldForwardExtendedContext = extendedContext && modelSupportsContext1mBeta(model) && !isClaudeCodeCompatible(this.provider);
      const shouldForwardCcCompatibleContext1m = isClaudeCodeCompatible(this.provider) && ccRequestDefaults.context1m === true;
      if (shouldForwardExtendedContext || shouldForwardCcCompatibleContext1m) {
        appendAnthropicBetaHeader(headers, CONTEXT_1M_BETA_HEADER);
      }
      const rawTransformedBody = await this.transformRequest(model, body, stream, requestCredentials);
      let transformedBody = sanitizeReasoningEffortForProvider(rawTransformedBody, this.provider, model, log);
      if (this.provider === "groq") {
        transformedBody = stripGroqUnsupportedFields(transformedBody);
      }
      try {
        // Timeout only covers response start; stream stalls are handled downstream.
        const fetchStartTimeoutMs = this.getTimeoutMs();
        const fetchWithStartTimeout = async (requestUrl, requestOptions) => {
          const timeoutController = fetchStartTimeoutMs > 0 ? new AbortController() : null;
          let timeoutId = null;
          if (timeoutController) {
            timeoutId = setTimeout(() => {
              const timeoutError = new Error(`Upstream request did not return response headers after ${fetchStartTimeoutMs}ms (${this.provider}/${model})`);
              timeoutError.name = "TimeoutError";
              timeoutController.abort(timeoutError);
            }, fetchStartTimeoutMs);
          }
          const timeoutSignal = timeoutController?.signal ?? null;
          const combinedSignal = signal && timeoutSignal ? mergeAbortSignals(signal, timeoutSignal) : signal || timeoutSignal;
          const optionsWithSignal = combinedSignal ? {
            ...requestOptions,
            signal: combinedSignal
          } : requestOptions;
          try {
            return await fetch(requestUrl, optionsWithSignal);
          } finally {
            if (timeoutId) clearTimeout(timeoutId);
          }
        };
        const isClaudeCodeClient = clientHeaders?.["x-app"] === "cli" || clientHeaders?.["user-agent"] && clientHeaders["user-agent"].toLowerCase().includes("claude-code") || clientHeaders?.["user-agent"] && clientHeaders["user-agent"].toLowerCase().includes("claude-cli");

        // Anthropic's user:sessions:claude_code OAuth scope expects CLI-shaped
        // traffic. Apply the cloak whenever we have an OAuth token, regardless
        // of upstream client.
        const hasClaudeOAuthToken = typeof activeCredentials?.accessToken === "string" && activeCredentials.accessToken.startsWith("sk-ant-oat") && !activeCredentials?.apiKey;
        if (this.provider === "claude" && (isClaudeCodeClient || hasClaudeOAuthToken) && typeof transformedBody === "object" && transformedBody !== null) {
          const tb = transformedBody;
          stripProxyToolPrefix(tb);
          remapToolNamesInRequest(tb);
          // Cloak third-party tool names + sanitize invalid tool schemas so
          // Anthropic does not refuse native Claude OAuth traffic with a
          // misleading "out of extra usage" placeholder. See Spec E.
          cloakThirdPartyToolNames(tb);
          if (Array.isArray(tb.tools)) {
            tb.tools = sanitizeClaudeToolSchemas(tb.tools);
          }
          obfuscateInBody(tb);

          // NOTE (issue #2260): This is the native `claude` provider OAuth path.
          // It is intentionally NOT routed through applyCcBridgeTransformPipeline.
          // The native OAuth path already prepends its own billing line + sentinel
          // (see lines ~744-773 below, dayStamp-based, cc_entrypoint=cli, cch=00000
          // placeholder, signed at body level). The CC bridge transforms DSL is
          // wired into buildAndSignClaudeCodeRequest (claudeCodeCompatible.ts step 5b)
          // which is the anthropic-compatible-cc-* relay path — a different,
          // separately classified surface. Do not double-prepend here.

          // Real CLI never sets cache_control on tools.
          if (Array.isArray(tb.tools)) {
            for (const t of tb.tools) {
              delete t.cache_control;
            }
            // Also strip OmniRoute provider prefix from versioned built-in tool
            // model fields (e.g. cc/claude-opus-4-8 → claude-opus-4-8).
            stripVersionedToolModelPrefix(tb.tools);
          }

          // Per-request behavior overrides via custom client headers.
          //   x-omniroute-effort:   low | medium | high | xhigh | max | off
          //   x-omniroute-thinking: adaptive | off
          // A header value applies only when the corresponding body field is
          // not already set; "off" force-strips the field.
          const headerEffort = (clientHeaders?.["x-omniroute-effort"] ?? clientHeaders?.["X-OmniRoute-Effort"])?.trim().toLowerCase();
          const headerThinking = (clientHeaders?.["x-omniroute-thinking"] ?? clientHeaders?.["X-OmniRoute-Thinking"])?.trim().toLowerCase();
          let appliedEffort = null;
          let appliedThinking = null;
          if (headerEffort === "off") {
            if (tb.output_config && typeof tb.output_config === "object") {
              delete tb.output_config.effort;
            }
            appliedEffort = "off";
          } else if (headerEffort && ["low", "medium", "high", "xhigh", "max"].includes(headerEffort)) {
            const oc = tb.output_config && typeof tb.output_config === "object" ? tb.output_config : {};
            if (oc.effort === undefined) {
              oc.effort = headerEffort;
              tb.output_config = oc;
              appliedEffort = headerEffort;
            }
          }

          // Anthropic rejects `thinking` (enabled/adaptive) when tool_choice forces a
          // specific tool ({type:"any"|"tool"}): "Thinking may not be enabled when
          // tool_choice forces tool use". Treat forced tool_choice as an implicit
          // `thinking: off` so neither the explicit-adaptive branch nor the default CC
          // injection below produces the invalid combination (incl. client-sent thinking).
          const toolChoiceForced = tb.tool_choice === "any" || typeof tb.tool_choice === "object" && tb.tool_choice !== null && (tb.tool_choice.type === "any" || tb.tool_choice.type === "tool");
          const effThinking = toolChoiceForced ? "off" : headerThinking;
          if (effThinking === "adaptive") {
            if (tb.thinking === undefined) {
              tb.thinking = {
                type: "adaptive"
              };
              appliedThinking = "adaptive";
            }
            if (tb.context_management === undefined) {
              tb.context_management = {
                edits: [{
                  type: "clear_thinking_20251015",
                  keep: "all"
                }]
              };
            }
          } else if (effThinking === "off") {
            delete tb.thinking;
            delete tb.context_management;
            appliedThinking = "off";
          } else if (!effThinking && !headerEffort && isClaudeCodeClient) {
            // Default Claude Code logic when no override headers are present.
            // Generic OpenAI-compatible clients that route through native Claude OAuth
            // must opt in with x-omniroute-thinking; force-injecting adaptive thinking
            // leaks non-standard reasoning replay fields back into those clients.
            const isHaiku = typeof tb.model === "string" && tb.model.includes("haiku");
            // #5312 RC-B: honor the operator's proxy-level Thinking-Budget mode.
            // `auto` means "strip — let the provider decide", so suppress the default
            // adaptive injection. Passthrough/no-config keeps the native Claude Code
            // behavior (adaptive) so #4633 does not regress (request-side only).
            const tbMode = getThinkingBudgetConfig().mode;
            if (isHaiku) {
              // Keep tb.thinking — real Claude Desktop keeps thinking enabled for Haiku
              // (issue #2454). Only strip output_config (effort) which Haiku rejects;
              // context_management is re-paired with the preserved thinking below.
              delete tb.output_config;
              delete tb.context_management;
            } else if (tbMode === ThinkingMode.AUTO) {
              delete tb.thinking;
              delete tb.context_management;
              delete tb.output_config;
            } else if (tb.thinking === undefined && tb.output_config === undefined) {
              tb.thinking = {
                type: "adaptive"
              };
              tb.context_management = {
                edits: [{
                  type: "clear_thinking_20251015",
                  keep: "all"
                }]
              };
              tb.output_config = {
                effort: "high"
              };
            }
            // #5312: Opus 4.7/4.8 accept only thinking.type="adaptive" ("enabled" → 400).
            // When an operator budget (custom/adaptive mode) produced an enabled block
            // upstream, remap it to adaptive + output_config.effort here.
            const th = tb.thinking;
            if (th?.type === "enabled" && tbMode !== ThinkingMode.PASSTHROUGH) {
              const b = typeof th.budget_tokens === "number" ? th.budget_tokens : 0;
              tb.thinking = {
                type: "adaptive"
              };
              tb.output_config = {
                effort: b <= 1024 ? "low" : b <= 10240 ? "medium" : b >= 131072 ? "max" : "high"
              };
              tb.context_management = {
                edits: [{
                  type: "clear_thinking_20251015",
                  keep: "all"
                }]
              };
            }
          }

          // Real CLI always pairs context_management with thinking. Mirror
          // that invariant so long sessions don't accumulate thinking blocks
          // toward the context cap.
          if (hasActiveClaudeThinking(tb) && !tb.context_management) {
            tb.context_management = {
              edits: [{
                type: "clear_thinking_20251015",
                keep: "all"
              }]
            };
          }
          const seed = activeCredentials?.accessToken || activeCredentials?.apiKey || "anon";
          const psd = activeCredentials?.providerSpecificData;
          let identitySource = "synthesized";
          let sessionId;
          let deviceId;
          let accountUUID;

          // For any Claude OAuth request, ignore client-supplied metadata.user_id /
          // X-Claude-Code-Session-Id and synthesize per-account: the CC device_id from
          // ~/.claude.json is shared across every account on one machine, which lets
          // Anthropic correlate accounts behind one OmniRoute.
          const cloakIdentity = isClaudeCodeClient || hasClaudeOAuthToken;
          const upstreamUserId = cloakIdentity ? null : parseUpstreamMetadataUserId(tb);
          if (upstreamUserId) {
            sessionId = upstreamUserId.session_id;
            deviceId = upstreamUserId.device_id;
            accountUUID = upstreamUserId.account_uuid;
            identitySource = "upstream-metadata";
          } else {
            const headerSid = cloakIdentity ? null : passthroughUpstreamSessionId(clientHeaders);
            sessionId = headerSid ?? getSessionId(seed);
            deviceId = resolveCliUserID(psd, seed);
            accountUUID = resolveAccountUUID(psd, seed, activeCredentials?.accessToken);
            identitySource = headerSid ? "upstream-header" : cloakIdentity ? "synthesized-cloaked" : "synthesized";
          }

          // system[0] (billing) and system[1] (sentinel) must not carry
          // cache_control — that belongs on upstream prompt blocks at [2..].
          const dayStamp = new Date().toISOString().slice(0, 10);
          const buildHash = buildHashFor(CLAUDE_CODE_VERSION, dayStamp);
          const billingLine = `x-anthropic-billing-header: cc_version=${CLAUDE_CODE_VERSION}.${buildHash}; cc_entrypoint=cli; cch=00000;`;
          const SENTINEL = "You are Claude Code, Anthropic's official CLI for Claude.";
          const sysBlocks = Array.isArray(tb.system) ? tb.system : typeof tb.system === "string" ? [{
            type: "text",
            text: tb.system
          }] : [];

          // Strip any pre-existing billing/sentinel before re-prepending — keeps
          // retries idempotent and avoids stacking that breaks prompt-cache prefix
          // matching (see issue #1712).
          for (let i = sysBlocks.length - 1; i >= 0; i--) {
            const t = sysBlocks[i]?.text;
            if (typeof t === "string" && t.startsWith("x-anthropic-billing-header:")) {
              sysBlocks.splice(i, 1);
            }
          }
          for (let i = sysBlocks.length - 1; i >= 0; i--) {
            const t = sysBlocks[i]?.text;
            if (typeof t === "string" && t.startsWith(SENTINEL)) {
              sysBlocks.splice(i, 1);
            }
          }
          sysBlocks.unshift({
            type: "text",
            text: billingLine
          }, {
            type: "text",
            text: SENTINEL
          });
          tb.system = sysBlocks;

          // Run the configurable system-transforms pipeline for the native
          // `claude` provider (issue #2260 / comment 4459544580). The default
          // claude pipeline runs cosmetic ops only (Open WebUI paragraph
          // anchors, identity-prefix paragraph drop, ZWJ obfuscation of
          // sensitive words). It deliberately does NOT include
          // `inject_billing_header` — billing + sentinel are already
          // prepended above. Users can extend the pipeline via Settings UI.
          {
            const transformResult = applySystemTransformPipeline(PROVIDER_CLAUDE, tb);
            if (transformResult.appliedOpKinds.length > 0) {
              console.log(`[SystemTransforms] claude-native: ${transformResult.appliedOpKinds.join(", ")}`);
            }
          }
          if (!tb.metadata || typeof tb.metadata !== "object") tb.metadata = {};
          tb.metadata.user_id = buildUserIdJson({
            deviceId,
            accountUUID,
            sessionId
          });

          // Headers. Accept stays application/json even on streams (Stainless
          // convention; SSE decoding is gated on body.stream). anthropic-beta
          // is selected per request shape; the full set on a quota probe is
          // itself a fingerprint.
          // Respect the client's negotiated anthropic-beta (real Claude Code) instead
          // of force-injecting thinking/effort betas it never requested (#3415).
          const clientAnthropicBeta = clientHeaders?.["anthropic-beta"] ?? clientHeaders?.["Anthropic-Beta"] ?? null;
          const ccHeaders = {
            Accept: "application/json",
            "anthropic-version": "2023-06-01",
            // #3974: merge the client's allowlisted betas (e.g. tool-search-tool)
            // on top of the shape-derived set so deferred-tool requests are not
            // rejected; selectBetaFlags still gates thinking/effort per #3415.
            "anthropic-beta": mergeClientAnthropicBeta(selectBetaFlags(tb, null, clientAnthropicBeta), clientAnthropicBeta),
            "anthropic-dangerous-direct-browser-access": "true",
            "x-app": "cli",
            "User-Agent": `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`,
            "X-Stainless-Package-Version": CLAUDE_CODE_STAINLESS_VERSION,
            "X-Stainless-Timeout": "600",
            "accept-encoding": "gzip, deflate, br, zstd",
            connection: "keep-alive",
            "x-client-request-id": randomUUID(),
            "X-Claude-Code-Session-Id": sessionId
          };

          // Drop case variants of the same header name before merging — undici
          // would otherwise concatenate them (issue #1454).
          const ccKeysLower = new Set(Object.keys(ccHeaders).map(k => k.toLowerCase()));
          for (const key of Object.keys(headers)) {
            if (ccKeysLower.has(key.toLowerCase())) delete headers[key];
          }
          Object.assign(headers, ccHeaders);
          delete headers["X-Stainless-Helper-Method"];

          // Stainless OS/Arch/Runtime are host-derived (Stainless SDK does the
          // same at runtime). Hardcoding them was a unique-per-deployment tell.
          headers["X-Stainless-Arch"] = stainlessArch();
          headers["X-Stainless-Lang"] = "js";
          headers["X-Stainless-OS"] = stainlessOS();
          headers["X-Stainless-Runtime"] = "node";
          headers["X-Stainless-Runtime-Version"] = stainlessRuntimeVersion();
          headers["X-Stainless-Retry-Count"] = "0";
          delete headers["X-Stainless-Os"];
          const overrideTag = appliedEffort || appliedThinking ? ` overrides=effort:${appliedEffort ?? "-"},thinking:${appliedThinking ?? "-"}` : "";
          log?.debug?.("CLAUDE", `identity=${identitySource} sid=${sessionId.slice(0, 8)} dev=${deviceId.slice(0, 8)} acct=${accountUUID.slice(0, 8)}${overrideTag}`);
        }

        // CLI fingerprint ordering — always-on for native Claude OAuth, opt-in
        // for other providers. Header + body field order is itself a fingerprint.
        let finalHeaders = headers;
        // Strip internal sentinel fields set by remapToolNamesInRequest before
        // serializing — Anthropic rejects unknown top-level fields (issue #2260).
        delete transformedBody["_claudeCodeRequiresLowercaseToolNames"];
        // Guard against orphan tool_use / tool_result pairs. Clients can ship
        // truncated histories mid-tool-call which Anthropic rejects with
        // `messages.N: tool_use ids were found without tool_result blocks
        // immediately after: toolu_...`. fixToolPairs strips orphans, then
        // stripTrailingAssistantOrphanToolUse catches the case where the
        // request body itself ends on an unmatched assistant(tool_use) —
        // invalid for an upstream-send turn since the body must end on a
        // user message. Both are idempotent on clean histories.
        {
          const tb = transformedBody;
          if (Array.isArray(tb?.messages)) {
            const fixed = fixToolPairs(tb.messages);
            // fixToolAdjacency enforces Claude's strict adjacency rule
            // (tool_result must be in immediately next message).
            // Only apply for Claude/Claude-compatible — OpenAI allows results
            // spread across multiple subsequent messages.
            const isClaude = this.provider === "claude" || isClaudeCodeCompatible(this.provider);
            // For Claude, fixToolAdjacency may strip tool_use blocks whose
            // tool_result isn't in the next message; re-run fixToolPairs to
            // drop any tool_result orphaned by that strip (discussion #2410).
            const adjacent = isClaude ? fixToolPairs(fixToolAdjacency(fixed)) : fixed;
            const stripped = stripTrailingAssistantOrphanToolUse(adjacent);
            // Some providers (e.g. Mistral) require the last message to be user
            // or tool and reject trailing assistant text messages with 400 (#3396).
            tb.messages = stripTrailingAssistantForProvider(stripped, this.provider);
          }
        }

        // Anthropic's extended-thinking contract forbids non-default sampling
        // params: temperature must be 1 and top_p >= 0.95 (or unset) whenever
        // thinking is enabled/adaptive. Thinking can be injected by per-model
        // requestDefaults *after* the translator/constraint passes, so normalize
        // at this final dispatch point — the single chokepoint every Claude
        // routing mode (grouped/raw/combo) and the native passthrough share,
        // before fingerprinting and CCH signing serialize the body.
        if (this.provider === "claude" || isClaudeCodeCompatible(this.provider)) {
          enforceThinkingTemperature(transformedBody);
        }

        // Delegated Context Editing (opt-in): attach the clear_tool_uses strategy so
        // the provider clears stale tool-use blocks server-side. Runs at this same
        // chokepoint, composing with the clear_thinking edit the fingerprint path may
        // have already set. Scoped to genuine `claude` (real Anthropic key/OAuth) and
        // `anthropic-compatible-cc-*` relays — the latter advertise Claude Code
        // compatibility, so they are the relays most likely to accept the beta. A
        // rejecting upstream is caught by the 400-fallback below. Deliberately
        // EXCLUDED: `claude-web` (a browser relay with a `create_conversation_params`
        // request shape that never sees `context_management`) and generic
        // `anthropic-compatible-*` (third-party endpoints with uncertain beta support).
        // `contextEditingDisabled` (set by the 400-fallback) suppresses re-injection
        // when a fresh `transformedBody` is built for a retry/fallback URL.
        if ((this.provider === "claude" || isClaudeCodeCompatible(this.provider)) && contextEditing?.enabled && !contextEditingDisabled) {
          applyContextEditingToBody(transformedBody, {
            enabled: true
          });
          log?.debug?.("CONTEXT_EDITING", "Delegated context editing on — attached clear_tool_uses to the Claude request");
        }
        let bodyString = JSON.stringify(transformedBody);
        const shouldFingerprint = isCliCompatEnabled(this.provider) || this.provider === "claude" && (isClaudeCodeClient || hasClaudeOAuthToken);
        if (shouldFingerprint) {
          const fingerprinted = applyFingerprint(this.provider, headers, transformedBody);
          finalHeaders = fingerprinted.headers;
          bodyString = fingerprinted.bodyString;
        }

        // CCH signing — replaces the cch=00000 placeholder in the billing
        // header with an xxHash64 integrity token over the serialized body.
        if (isClaudeCodeCompatible(this.provider) || this.provider === "claude") {
          bodyString = await signRequestBody(bodyString);
        }
        mergeUpstreamExtraHeaders(finalHeaders, upstreamExtraHeaders);
        const serializedBody = prl.parseBody(bodyString);
        // #4307 — Preserve the non-enumerable tool-name cloak/remap reverse map
        // (`_toolNameMap`, set on the live `transformedBody` by
        // remapToolNamesInRequest / cloakThirdPartyToolNames) that the JSON
        // round-trip above drops. chatCore's response-side un-cloak reads it off
        // `result.transformedBody` to restore the client's original tool-name
        // casing (e.g. `read`, not the cloaked `Read`). Without this re-attach the
        // map is lost and the client receives the cloaked casing — a regression
        // from #3941's serialized-body capture. Mirrors antigravity.ts's
        // `attachToolNameMap`; non-enumerable so it never re-serializes upstream.
        if (transformedBody && typeof transformedBody === "object" && serializedBody && typeof serializedBody === "object") {
          const liveToolNameMap = transformedBody._toolNameMap;
          if (liveToolNameMap instanceof Map && liveToolNameMap.size > 0 && !(serializedBody._toolNameMap instanceof Map)) {
            Object.defineProperty(serializedBody, "_toolNameMap", {
              value: liveToolNameMap,
              enumerable: false,
              configurable: true,
              writable: true
            });
          }
        }
        const fetchOptions = {
          method: "POST",
          headers: finalHeaders,
          body: bodyString
        };
        let response = await fetchWithStartTimeout(url, fetchOptions);

        // Context Editing 400-fallback for Claude-compatible relays.
        if (response.status === HTTP_STATUS.BAD_REQUEST && contextEditing?.enabled && !contextEditingDisabled && transformedBody && typeof transformedBody === "object" && transformedBody.context_management !== undefined) {
          const errText = await response.clone().text().catch(() => "");
          if (/context[_-]management|context editing/i.test(errText)) {
            contextEditingDisabled = true;
            delete transformedBody.context_management;
            let retryBody = JSON.stringify(transformedBody);
            if (isClaudeCodeCompatible(this.provider) || this.provider === "claude") {
              retryBody = await signRequestBody(retryBody);
            }
            log?.debug?.("CONTEXT_EDITING", `Upstream 400 rejected context_management on ${url} — retrying without it`);
            response = await fetchWithStartTimeout(url, {
              ...fetchOptions,
              body: retryBody
            });
          }
        }

        // Generic reactive 400 field-downgrade; each field is stripped at most once.
        if (response.status === HTTP_STATUS.BAD_REQUEST && transformedBody && typeof transformedBody === "object") {
          const errText = await response.clone().text().catch(() => "");
          const offending = findOffendingField(errText);
          if (offending && !strippedFields.has(offending) && transformedBody[offending] !== undefined) {
            strippedFields.add(offending);
            delete transformedBody[offending];
            let retryBody = JSON.stringify(transformedBody);
            if (isClaudeCodeCompatible(this.provider) || this.provider === "claude") {
              retryBody = await signRequestBody(retryBody);
            }
            log?.debug?.("FIELD_400", `Upstream 400 rejected ${offending} on ${url} — retrying without it`);
            response = await fetchWithStartTimeout(url, {
              ...fetchOptions,
              body: retryBody
            });
          }
        }

        // Intra-URL retry: if 429 and we haven't exhausted per-URL retries, wait and retry the same URL
        if (!skipUpstreamRetry && response.status === HTTP_STATUS.RATE_LIMITED && (retryAttemptsByUrl[urlIndex] ?? 0) < BaseExecutor.RETRY_CONFIG.maxAttempts) {
          retryAttemptsByUrl[urlIndex] = (retryAttemptsByUrl[urlIndex] ?? 0) + 1;
          const attempt = retryAttemptsByUrl[urlIndex];
          log?.debug?.("RETRY", `429 intra-retry ${attempt}/${BaseExecutor.RETRY_CONFIG.maxAttempts} on ${url} — waiting ${BaseExecutor.RETRY_CONFIG.delayMs}ms`);
          await new Promise(resolve => setTimeout(resolve, BaseExecutor.RETRY_CONFIG.delayMs));
          urlIndex--; // re-run this urlIndex on the next loop iteration
          continue;
        }

        // T07: Handle 401 authentication errors — log and continue to fallback
        if (response.status === 401 && credentials.connectionId && credentials.apiKey) {
          log?.warn?.("AUTH", `401 on ${url} - API key may be invalid`);
        }
        if (!skipUpstreamRetry && this.shouldRetry(response.status, urlIndex)) {
          log?.debug?.("RETRY", `${response.status} on ${url}, trying fallback ${urlIndex + 1}`);
          lastStatus = response.status;
          continue;
        }
        return {
          response,
          url,
          headers: finalHeaders,
          transformedBody: serializedBody
        };
      } catch (error) {
        // Distinguish timeout errors from other abort errors
        const err = error instanceof Error ? error : new Error(String(error));
        if (err.name === "TimeoutError") {
          log?.warn?.("TIMEOUT", err.message);
        }
        lastError = err;
        if (!skipUpstreamRetry && urlIndex + 1 < fallbackCount) {
          log?.debug?.("RETRY", `Error on ${url}, trying fallback ${urlIndex + 1}`);
          continue;
        }
        throw err;
      }
    }
    throw lastError || new Error(`All ${fallbackCount} URLs failed with status ${lastStatus}`);
  }
}
export default BaseExecutor;