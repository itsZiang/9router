import { createRequire } from "module";
import { getTlsClientTimeoutConfig } from "../stubs/shared/utils/runtimeTimeouts";
const require = createRequire(import.meta.url);
let createSession;
try {
  const loaded = require("wreq-js");
  createSession = typeof loaded.createSession === "function" ? loaded.createSession : null;
} catch {
  createSession = null;
}

/**
 * Get proxy URL from environment variables.
 * Priority: HTTPS_PROXY > HTTP_PROXY > ALL_PROXY
 */
function getProxyFromEnv() {
  return process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy || undefined;
}
function normalizeHeaders(headers) {
  if (!headers) return undefined;
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers.map(([key, value]) => [key, String(value)]));
  }
  const normalized = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      normalized[key] = value;
    }
  }
  return normalized;
}

/**
 * TLS Client — Chrome 124 TLS fingerprint spoofing via wreq-js
 * Singleton instance used to disguise Node.js TLS handshake as Chrome browser.
 *
 * wreq-js natively supports proxy — TLS fingerprinting works through proxy.
 * Proxy URL is read from environment variables (HTTPS_PROXY, HTTP_PROXY, ALL_PROXY).
 */
class TlsClient {
  session = null;
  _libraryAvailable;
  failureCount = 0;
  maxFailures = 3;
  baseCooldownMs = 30_000;
  cooldownMs = 30_000;
  cooldownMultiplier = 1;
  MAX_COOLDOWN_MS = 600_000; // 10 min
  circuitOpenUntil = 0;
  circuitTripped = false;
  constructor() {
    this._libraryAvailable = !!createSession;
  }
  get available() {
    if (!this._libraryAvailable) return false;
    if (!this.circuitTripped) return true;
    return Date.now() >= this.circuitOpenUntil;
  }
  recordFailure() {
    this.failureCount++;
    if (this.failureCount >= this.maxFailures) {
      this.circuitOpenUntil = Date.now() + this.cooldownMs;
      this.circuitTripped = true;
      // Close the stale session so the next half-open retry creates a
      // fresh one instead of reusing a broken connection.
      if (this.session) {
        Promise.resolve(this.session.close()).catch(() => {});
        this.session = null;
      }
      console.warn(`[TlsClient] Circuit opened after ${this.failureCount} consecutive failures, cooling down for ${this.cooldownMs}ms`);
      // Double cooldown for the next trip: 30s → 60s → 120s → ... → 10 min max
      this.escalateCooldown();
    }
  }
  recordSuccess() {
    this.failureCount = 0;
    if (this.circuitTripped) {
      this.cooldownMultiplier = 1;
      this.cooldownMs = this.baseCooldownMs;
      console.log("[TlsClient] Circuit closed (success after cooldown)");
      this.circuitTripped = false;
    }
  }
  escalateCooldown() {
    this.cooldownMultiplier = Math.min(this.cooldownMultiplier * 2, 20);
    this.cooldownMs = Math.min(this.baseCooldownMs * this.cooldownMultiplier, this.MAX_COOLDOWN_MS);
  }
  checkCircuit() {
    if (!this.circuitTripped) return true;
    if (Date.now() >= this.circuitOpenUntil) {
      console.log("[TlsClient] Half-open: retrying after cooldown");
      // Don't call recordSuccess() here — that would reset failureCount.
      // Instead, let the fetch() call succeed or fail naturally.
      // If it succeeds, recordSuccess() in fetch() handles cleanup.
      // If it fails, recordFailure() finds failureCount still >= maxFailures
      // and re-opens with escalated cooldown.
      return true;
    }
    return false;
  }
  async getSession() {
    if (!this.checkCircuit()) return null;
    if (!this.available) return null;
    if (this.session) return this.session;
    const createSessionFn = createSession;
    if (!createSessionFn) return null;
    const proxy = getProxyFromEnv();
    const sessionOpts = {
      browser: "chrome_124",
      os: "macos"
    };
    if (proxy) {
      sessionOpts.proxy = proxy;
      console.log(`[TlsClient] Using proxy: ${proxy}`);
    }
    this.session = await createSessionFn(sessionOpts);
    console.log("[TlsClient] Session created (Chrome 124 TLS fingerprint)");
    return this.session;
  }

  /**
   * Fetch with Chrome 124 TLS fingerprint.
   * wreq-js Response is already fetch-compatible (headers, text(), json(), clone(), body).
   */
  async fetch(url, options = {}) {
    if (!this.checkCircuit()) {
      throw new Error("wreq-js circuit open — skipping TLS request");
    }
    try {
      const session = await this.getSession();
      if (!session) throw new Error("wreq-js not available");
      const {
        timeoutMs
      } = getTlsClientTimeoutConfig(process.env, message => {
        console.warn(`[TlsClient] ${message}`);
      });
      const method = (options.method || "GET").toUpperCase();
      const wreqOptions = {
        method,
        headers: normalizeHeaders(options.headers),
        body: options.body,
        redirect: options.redirect === "manual" ? "manual" : "follow",
        timeout: timeoutMs
      };
      if (options.signal) {
        wreqOptions.signal = options.signal;
      }
      const response = await session.fetch(url, wreqOptions);
      this.recordSuccess();
      return response;
    } catch (err) {
      const isAbort = err instanceof Error && (err.name === "AbortError" || err.message.includes("aborted"));
      if (!isAbort) {
        this.recordFailure();
      }
      throw err;
    }
  }
  async exit() {
    if (this.session) {
      await this.session.close();
      this.session = null;
    }
  }
  resetCircuit() {
    this.failureCount = 0;
    this.circuitTripped = false;
    this.circuitOpenUntil = 0;
  }
  getCircuitState() {
    return {
      available: this.available,
      circuitTripped: this.circuitTripped,
      failureCount: this.failureCount,
      circuitOpenUntil: this.circuitOpenUntil,
      coolDownRemainingMs: this.circuitOpenUntil > 0 ? Math.max(0, this.circuitOpenUntil - Date.now()) : 0
    };
  }
}
const tlsClient = new TlsClient();
export default tlsClient;