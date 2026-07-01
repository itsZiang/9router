import { HTTP_STATUS, DEFAULT_RETRY_CONFIG, BACKOFF_CONFIG, FETCH_CONNECT_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { shouldRefreshCredentials } from "../services/oauthCredentialManager.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { dbg } from "../utils/debugLog.js";
import { ANTHROPIC_API_VERSION, OPENAI_COMPAT_BASE, ANTHROPIC_COMPAT_BASE } from "../providers/shared.js";
import { RetryEngine } from "../utils/retryEngine.js";

/**
 * BaseExecutor - Base class for provider executors
 */
export class BaseExecutor {
  constructor(provider, config) {
    this.provider = provider;
    this.config = config;
    this.noAuth = config?.noAuth || false;
  }

  getProvider() {
    return this.provider;
  }

  getProviderConfig() {
    return null;
  }

  getBaseUrls() {
    return this.config.baseUrls || (this.config.baseUrl ? [this.config.baseUrl] : []);
  }

  getFallbackCount() {
    return this.getBaseUrls().length || 1;
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    if (this.provider?.startsWith?.("openai-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || OPENAI_COMPAT_BASE;
      const normalized = baseUrl.replace(/\/$/, "");
      const path = this.provider.includes("responses") ? "/responses" : "/chat/completions";
      return `${normalized}${path}`;
    }
    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || ANTHROPIC_COMPAT_BASE;
      const normalized = baseUrl.replace(/\/$/, "");
      return `${normalized}/messages`;
    }
    const baseUrls = this.getBaseUrls();
    return baseUrls[urlIndex] || baseUrls[0] || this.config.baseUrl;
  }

  buildHeaders(credentials, stream = true) {
    const headers = {
      "Content-Type": "application/json",
      ...this.config.headers
    };

    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      // Anthropic-compatible providers use x-api-key header
      if (credentials.apiKey) {
        headers["x-api-key"] = credentials.apiKey;
      } else if (credentials.accessToken) {
        headers["Authorization"] = `Bearer ${credentials.accessToken}`;
      }
      if (!headers["anthropic-version"]) {
        headers["anthropic-version"] = ANTHROPIC_API_VERSION;
      }
    } else {
      // Standard Bearer token auth for other providers
      if (credentials.accessToken) {
        headers["Authorization"] = `Bearer ${credentials.accessToken}`;
      } else if (credentials.apiKey) {
        headers["Authorization"] = `Bearer ${credentials.apiKey}`;
      }
    }

    if (stream) {
      headers["Accept"] = "text/event-stream";
    }

    return headers;
  }

  // Override in subclass for provider-specific transformations
  transformRequest(model, body, stream, credentials) {
    return body;
  }

  // Statuses that should advance to the next base URL (mirror/region) instead of
  // retrying the same URL. 400-class errors are excluded — a different URL won't
  // fix a malformed request.
  static URL_FALLBACK_STATUSES = new Set([
    HTTP_STATUS.RATE_LIMITED,   // 429
    HTTP_STATUS.BAD_GATEWAY,     // 502
    HTTP_STATUS.SERVICE_UNAVAILABLE, // 503
    HTTP_STATUS.GATEWAY_TIMEOUT, // 504
    524,                         // Cloudflare timeout
  ]);

  shouldRetry(status, urlIndex) {
    return BaseExecutor.URL_FALLBACK_STATUSES.has(status) && urlIndex + 1 < this.getFallbackCount();
  }

  // Override in subclass for provider-specific refresh
  async refreshCredentials(credentials, log, proxyOptions = null) {
    return null;
  }

  needsRefresh(credentials) {
    return shouldRefreshCredentials(this.provider, credentials);
  }

  parseError(response, bodyText) {
    return { status: response.status, message: bodyText || `HTTP ${response.status}` };
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const fallbackCount = this.getFallbackCount();
    let lastError = null;
    let lastStatus = 0;
    const retryAttemptsByUrl = {};
    let attemptedRetries = 0;
    let maxRetries = 0;

    // Merge default retry policy with provider-specific config and build the engine.
    const retryConfig = { ...DEFAULT_RETRY_CONFIG, ...this.config.retry };
    const retryEngine = new RetryEngine({ perStatusConfig: retryConfig, maxDelayMs: BACKOFF_CONFIG.max });
    const customDelay = this.computeRetryDelay
      ? (response, attempt, baseDelayMs) => this.computeRetryDelay(response, attempt, baseDelayMs)
      : null;

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    const providerConfig = this.getProviderConfig();

    for (let urlIndex = 0; urlIndex < fallbackCount; urlIndex++) {
      const baseUrls = this.getBaseUrls();
      const url = providerConfig
        ? providerConfig.buildUrl({
            apiBase: baseUrls[urlIndex] || baseUrls[0] || this.config.baseUrl,
            apiKey: credentials?.apiKey,
            model,
            optionalParams: body,
            stream,
            credentials,
            urlIndex,
            baseUrls
          })
        : this.buildUrl(model, stream, urlIndex, credentials);

      const transformedBody = providerConfig
        ? providerConfig.transformRequest({
            model,
            messages: body?.messages,
            optionalParams: body,
            stream,
            credentials,
            body
          })
        : this.transformRequest(model, body, stream, credentials);

      const headers = providerConfig
        ? providerConfig.buildHeaders({ credentials, stream, requestData: transformedBody })
        : this.buildHeaders(credentials, stream);

      if (providerConfig && typeof providerConfig.signRequest === "function") {
        providerConfig.signRequest({ headers, requestData: transformedBody, apiKey: credentials?.apiKey });
      }

      if (!retryAttemptsByUrl[urlIndex]) retryAttemptsByUrl[urlIndex] = 0;

      // Abort if upstream doesn't return response headers within connection timeout
      const connectCtrl = new AbortController();
      const timeoutMs = this.config?.timeoutMs || FETCH_CONNECT_TIMEOUT_MS;
      const connectTimer = setTimeout(() => connectCtrl.abort(new Error("fetch connect timeout")), timeoutMs);
      const mergedSignal = signal ? AbortSignal.any([signal, connectCtrl.signal]) : connectCtrl.signal;

      try {
        const bodyStr = JSON.stringify(transformedBody);
        const fetchT0 = Date.now();
        dbg("FETCH", `${this.provider.toUpperCase()} → ${url} | body=${bodyStr.length}B | connectTimeout=${timeoutMs}ms`);
        const response = await proxyAwareFetch(url, {
          method: "POST",
          headers,
          body: bodyStr,
          signal: mergedSignal
        }, proxyOptions);
        clearTimeout(connectTimer);
        const ct = response.headers?.get?.("content-type") || "";
        const cl = response.headers?.get?.("content-length") || "?";
        dbg("FETCH", `${this.provider.toUpperCase()} ← ${response.status} | ttft=${Date.now() - fetchT0}ms | ct=${ct} | cl=${cl}`);

        // URL-fallback takes priority: if an alternative base URL exists and the
        // status warrants it (429/502/503/504/524), advance immediately without
        // delay. This makes failover near-instant when mirrors/regions are
        // configured, reserving backoff for single-URL scenarios.
        if (this.shouldRetry(response.status, urlIndex)) {
          lastStatus = response.status;
          try { await response.body?.cancel?.(); } catch { /* best-effort cleanup */ }
          log?.debug?.("RETRY", `${response.status} on URL[${urlIndex}], instant failover to URL[${urlIndex + 1}]`);
          continue;
        }

        const plan = await retryEngine.plan({
          status: response.status,
          attempt: retryAttemptsByUrl[urlIndex] + 1,
          response,
          customDelay
        });

        if (plan.retry) {
          retryAttemptsByUrl[urlIndex]++;
          attemptedRetries++;
          maxRetries = Math.max(maxRetries, plan.maxRetries || 0);
          log?.debug?.("RETRY", `${response.status} retry ${retryAttemptsByUrl[urlIndex]}/${plan.maxRetries} after ${plan.delayMs / 1000}s (${plan.reason})`);
          try { await response.body?.cancel?.(); } catch { /* best-effort cleanup */ }
          await sleep(plan.delayMs);
          urlIndex--;
          continue;
        }

        return { response, url, headers, transformedBody, attemptedRetries, maxRetries };
      } catch (error) {
        clearTimeout(connectTimer);
        lastError = error;
        const isConnectTimeout = connectCtrl.signal.aborted && error.name === "AbortError";
        dbg("FETCH", `${this.provider.toUpperCase()} ✖ ${error.name}: ${error.message}${isConnectTimeout ? " (connect timeout)" : ""}`);
        // Connect timeout is internal — convert to retryable network error, don't propagate AbortError
        if (error.name === "AbortError" && !isConnectTimeout) throw error;

        // Map network/fetch exceptions to 502 retry policy.
        // Instant failover: if an alternative URL exists, advance without delay.
        if (urlIndex + 1 < fallbackCount) {
          log?.debug?.("RETRY", `Network error on URL[${urlIndex}], instant failover to URL[${urlIndex + 1}]`);
          continue;
        }

        // No alternative URL — same-URL retry with backoff
        const networkPlan = await retryEngine.plan({
          status: HTTP_STATUS.BAD_GATEWAY,
          attempt: retryAttemptsByUrl[urlIndex] + 1,
          error
        });

        if (networkPlan.retry) {
          retryAttemptsByUrl[urlIndex]++;
          attemptedRetries++;
          maxRetries = Math.max(maxRetries, networkPlan.maxRetries || 0);
          log?.debug?.("RETRY", `network retry ${retryAttemptsByUrl[urlIndex]}/${networkPlan.maxRetries} after ${networkPlan.delayMs / 1000}s (${networkPlan.reason})`);
          await sleep(networkPlan.delayMs);
          urlIndex--;
          continue;
        }

        throw error;
      }
    }

    throw lastError || new Error(`All ${fallbackCount} URLs failed with status ${lastStatus}`);
  }
}

export default BaseExecutor;
