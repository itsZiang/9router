// HttpClientCache — pooled undici agents keyed by proxy URL + pool parameters.
// Replaces per-request fresh ProxyAgent / Agent creation to reduce TCP/TLS
// handshake overhead and avoid leaking agents.

import {
  HTTP_POOL_LIMIT,
  HTTP_KEEPALIVE_TIMEOUT_MS,
  HTTP_CLIENT_CACHE_TTL_MS,
  MEMORY_CONFIG,
} from "../config/runtimeConfig.js";

// TCP keepalive: send probes after 30s of idle to detect dead connections
// reaped by NAT gateways / load balancers before undici tries to reuse them.
const TCP_KEEPALIVE_INITIAL_DELAY_MS = 30_000;

function normalizeProxyUrl(proxyUrl) {
  if (proxyUrl === undefined || proxyUrl === null) return null;
  const input = String(proxyUrl).trim();
  if (!input) return null;
  try {
    new URL(input);
    return input;
  } catch {
    return `http://${input}`;
  }
}

function buildKey({ proxyUrl, connectTimeout, keepAliveTimeout, poolLimit }) {
  return JSON.stringify({
    proxyUrl: proxyUrl || null,
    connectTimeout,
    keepAliveTimeout,
    poolLimit,
  });
}

export class HttpClientCache {
  constructor({
    poolLimit = HTTP_POOL_LIMIT,
    keepAliveTimeout = HTTP_KEEPALIVE_TIMEOUT_MS,
    defaultTtlMs = HTTP_CLIENT_CACHE_TTL_MS,
    maxSize = MEMORY_CONFIG.proxyDispatchersMaxSize,
  } = {}) {
    this.poolLimit = poolLimit;
    this.keepAliveTimeout = keepAliveTimeout;
    this.defaultTtlMs = defaultTtlMs;
    this.maxSize = maxSize > 0 ? maxSize : MEMORY_CONFIG.proxyDispatchersMaxSize;
    this._cache = new Map();
  }

  _prune() {
    const now = Date.now();
    for (const [key, entry] of this._cache) {
      if (entry.expiresAt <= now) {
        this._closeAgent(entry.agent);
        this._cache.delete(key);
      }
    }
  }

  _closeAgent(agent) {
    if (!agent) return;
    try { agent.close?.(); } catch { /* ignore */ }
    try { agent.destroy?.(); } catch { /* ignore */ }
  }

  _getOrCreate(key, factory) {
    this._prune();
    const now = Date.now();
    const entry = this._cache.get(key);
    if (entry && entry.expiresAt > now) {
      // Refresh TTL on every access so hot agents stay alive.
      entry.expiresAt = now + this.defaultTtlMs;
      return entry.agent;
    }
    // Enforce max size: evict the oldest entry before inserting a new one
    if (this._cache.size >= this.maxSize) {
      let oldestKey = null;
      let oldestExpiry = Infinity;
      for (const [k, e] of this._cache) {
        if (e.expiresAt < oldestExpiry) {
          oldestExpiry = e.expiresAt;
          oldestKey = k;
        }
      }
      if (oldestKey) {
        this._closeAgent(this._cache.get(oldestKey)?.agent);
        this._cache.delete(oldestKey);
      }
    }
    const agent = factory();
    this._cache.set(key, { agent, expiresAt: now + this.defaultTtlMs });
    return agent;
  }

  _resolveOpts({ connectTimeout, keepAliveTimeout, poolLimit } = {}) {
    return {
      connectTimeout: connectTimeout ?? 0,
      keepAliveTimeout: keepAliveTimeout ?? this.keepAliveTimeout,
      poolLimit: poolLimit ?? this.poolLimit,
    };
  }

  // Build the `connect` option for undici Agent/ProxyAgent.
  // TCP keepalive is always enabled to prevent silent socket reaping by
  // NAT gateways / load balancers on idle pooled connections.
  _buildConnectOpts(connectTimeout) {
    const connect = {
      keepAlive: true,
      keepAliveInitialDelay: TCP_KEEPALIVE_INITIAL_DELAY_MS,
    };
    if (connectTimeout > 0) {
      connect.timeout = connectTimeout;
    }
    return { connect };
  }

  /**
   * Return a cached (or newly created) undici Agent for direct (non-proxy) fetches.
   * bodyTimeout/headersTimeout are forced to 0 so long SSE streams are not killed
   * by undici's default 300 s timeout.
   */
  async getAgent(opts = {}) {
    const resolved = this._resolveOpts(opts);
    const key = buildKey({ proxyUrl: null, ...resolved });

    const { Agent } = await import("undici");
    return this._getOrCreate(key, () => {
      const agentOpts = {
        keepAliveTimeout: resolved.keepAliveTimeout,
        connections: resolved.poolLimit,
        bodyTimeout: 0,
        headersTimeout: 0,
        ...this._buildConnectOpts(resolved.connectTimeout),
      };
      return new Agent(agentOpts);
    });
  }

  /**
   * Return a cached (or newly created) undici ProxyAgent for proxy fetches.
   * Returns null if proxyUrl is empty/invalid.
   */
  async getProxyAgent(proxyUrl, opts = {}) {
    const normalized = normalizeProxyUrl(proxyUrl);
    if (!normalized) return null;

    const resolved = this._resolveOpts(opts);
    const key = buildKey({ proxyUrl: normalized, ...resolved });

    const { ProxyAgent } = await import("undici");
    return this._getOrCreate(key, () => {
      const agentOpts = {
        uri: normalized,
        keepAliveTimeout: resolved.keepAliveTimeout,
        connections: resolved.poolLimit,
        bodyTimeout: 0,
        headersTimeout: 0,
        ...this._buildConnectOpts(resolved.connectTimeout),
      };
      return new ProxyAgent(agentOpts);
    });
  }

  clear() {
    for (const entry of this._cache.values()) {
      this._closeAgent(entry.agent);
    }
    this._cache.clear();
  }

  size() {
    this._prune();
    return this._cache.size;
  }
}

// Process-global singleton. Tests can replace or clear via httpClientCache.clear().
export const httpClientCache = new HttpClientCache();

export default httpClientCache;
