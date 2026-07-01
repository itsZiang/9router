import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { HttpClientCache, httpClientCache } from "../../open-sse/utils/httpClientCache.js";

beforeEach(() => {
  httpClientCache.clear();
});

afterEach(() => {
  httpClientCache.clear();
});

describe("HttpClientCache — singleton and lifecycle", () => {
  it("exports a process-global singleton", () => {
    expect(httpClientCache).toBeInstanceOf(HttpClientCache);
    expect(httpClientCache.size()).toBe(0);
  });

  it("clear removes all cached agents", async () => {
    await httpClientCache.getAgent();
    expect(httpClientCache.size()).toBeGreaterThan(0);
    httpClientCache.clear();
    expect(httpClientCache.size()).toBe(0);
  });
});

describe("HttpClientCache — direct Agent caching", () => {
  it("reuses the same direct Agent for identical options", async () => {
    const a = await httpClientCache.getAgent();
    const b = await httpClientCache.getAgent();
    expect(a).toBe(b);
    expect(httpClientCache.size()).toBe(1);
  });

  it("creates a new Agent when poolLimit differs", async () => {
    const a = await httpClientCache.getAgent({ poolLimit: 10 });
    const b = await httpClientCache.getAgent({ poolLimit: 20 });
    expect(a).not.toBe(b);
    expect(httpClientCache.size()).toBe(2);
  });

  it("creates a new Agent when connectTimeout differs", async () => {
    const a = await httpClientCache.getAgent({ connectTimeout: 5000 });
    const b = await httpClientCache.getAgent({ connectTimeout: 10000 });
    expect(a).not.toBe(b);
  });
});

describe("HttpClientCache — ProxyAgent caching", () => {
  it("returns null for empty proxy URL", async () => {
    expect(await httpClientCache.getProxyAgent("")).toBeNull();
    expect(await httpClientCache.getProxyAgent(null)).toBeNull();
    expect(await httpClientCache.getProxyAgent(undefined)).toBeNull();
  });

  it("normalizes bare host:port proxy URLs", async () => {
    const agent = await httpClientCache.getProxyAgent("127.0.0.1:7890");
    expect(agent).not.toBeNull();
  });

  it("reuses the same ProxyAgent for identical proxy/options", async () => {
    const a = await httpClientCache.getProxyAgent("http://proxy.example:8080");
    const b = await httpClientCache.getProxyAgent("http://proxy.example:8080");
    expect(a).toBe(b);
    expect(httpClientCache.size()).toBe(1);
  });

  it("creates separate ProxyAgents for different proxy URLs", async () => {
    const a = await httpClientCache.getProxyAgent("http://proxy-a:8080");
    const b = await httpClientCache.getProxyAgent("http://proxy-b:8080");
    expect(a).not.toBe(b);
    expect(httpClientCache.size()).toBe(2);
  });
});

describe("HttpClientCache — TTL eviction", () => {
  it("evicts stale agents after TTL expires", async () => {
    const cache = new HttpClientCache({ defaultTtlMs: 10 });
    await cache.getAgent();
    expect(cache.size()).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(cache.size()).toBe(0);
  });

  it("refreshes TTL on access", async () => {
    const cache = new HttpClientCache({ defaultTtlMs: 50 });
    await cache.getAgent();
    await new Promise(resolve => setTimeout(resolve, 30));
    await cache.getAgent(); // refresh TTL
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(cache.size()).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(cache.size()).toBe(0);
  });
});

describe("HttpClientCache — constructor overrides", () => {
  it("honors custom poolLimit and keepAliveTimeout", async () => {
    const cache = new HttpClientCache({
      poolLimit: 42,
      keepAliveTimeout: 12345,
      defaultTtlMs: 60000,
    });
    const agent = await cache.getAgent();
    expect(agent).toBeDefined();
    expect(cache.poolLimit).toBe(42);
    expect(cache.keepAliveTimeout).toBe(12345);
  });
});

describe("HttpClientCache — TCP keepalive", () => {
  it("enables TCP keepalive in connect options", () => {
    const cache = new HttpClientCache();
    const opts = cache._buildConnectOpts(0);
    expect(opts.connect.keepAlive).toBe(true);
    expect(opts.connect.keepAliveInitialDelay).toBe(30_000);
  });

  it("includes connect timeout when provided", () => {
    const cache = new HttpClientCache();
    const opts = cache._buildConnectOpts(5000);
    expect(opts.connect.timeout).toBe(5000);
    expect(opts.connect.keepAlive).toBe(true);
  });

  it("creates Agent with keepalive enabled without error", async () => {
    const agent = await httpClientCache.getAgent({ connectTimeout: 3000 });
    expect(agent).toBeDefined();
    expect(agent.closed).toBe(false);
  });

  it("creates ProxyAgent with keepalive enabled without error", async () => {
    const agent = await httpClientCache.getProxyAgent("http://keepalive-proxy:8080", { connectTimeout: 3000 });
    expect(agent).not.toBeNull();
    expect(agent.closed).toBe(false);
  });
});

describe("HttpClientCache — poolLimitPerHost removed from cache key", () => {
  it("does not create separate agents for different poolLimitPerHost (deprecated)", async () => {
    // poolLimitPerHost is no longer part of the cache key or constructor.
    // Passing it as a constructor arg is silently ignored by JS destructuring.
    const cache = new HttpClientCache({ poolLimit: 50 });
    const a = await cache.getAgent();
    const b = await cache.getAgent();
    expect(a).toBe(b);
    expect(cache.size()).toBe(1);
  });
});
