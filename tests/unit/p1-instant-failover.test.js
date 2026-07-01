import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { BaseExecutor } = await import("../../open-sse/executors/base.js");

function res(status, headers = {}) {
  return { status, headers: { get: (k) => headers[k.toLowerCase()] ?? "" } };
}

function makeExec(config) {
  return new BaseExecutor("test", config);
}

const creds = { apiKey: "k" };

beforeEach(() => fetchMock.mockReset());

describe("P1 #5 — URL-fallback for 5xx (not just 429)", () => {
  it("falls over to the next url on 502", async () => {
    const ex = makeExec({ baseUrls: ["https://a/api", "https://b/api"], retry: { 502: { attempts: 3, delayMs: 0 } } });
    fetchMock
      .mockResolvedValueOnce(res(502))
      .mockResolvedValueOnce(res(200));
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    expect(out.response.status).toBe(200);
    expect(out.url).toBe("https://b/api");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls over to the next url on 503", async () => {
    const ex = makeExec({ baseUrls: ["https://a/api", "https://b/api"], retry: { 503: { attempts: 3, delayMs: 0 } } });
    fetchMock
      .mockResolvedValueOnce(res(503))
      .mockResolvedValueOnce(res(200));
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    expect(out.response.status).toBe(200);
    expect(out.url).toBe("https://b/api");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls over to the next url on 504", async () => {
    const ex = makeExec({ baseUrls: ["https://a/api", "https://b/api"], retry: { 504: { attempts: 2, delayMs: 0 } } });
    fetchMock
      .mockResolvedValueOnce(res(504))
      .mockResolvedValueOnce(res(200));
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    expect(out.response.status).toBe(200);
    expect(out.url).toBe("https://b/api");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls over to the next url on 524 (Cloudflare timeout)", async () => {
    const ex = makeExec({ baseUrls: ["https://a/api", "https://b/api"], retry: { 524: { attempts: 2, delayMs: 0 } } });
    fetchMock
      .mockResolvedValueOnce(res(524))
      .mockResolvedValueOnce(res(200));
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    expect(out.response.status).toBe(200);
    expect(out.url).toBe("https://b/api");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT URL-fallback on 400 (malformed request)", async () => {
    const ex = makeExec({ baseUrls: ["https://a/api", "https://b/api"] });
    fetchMock.mockResolvedValueOnce(res(400));
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    expect(out.response.status).toBe(400);
    expect(out.url).toBe("https://a/api");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT URL-fallback on 500 (not in URL_FALLBACK_STATUSES)", async () => {
    const ex = makeExec({ baseUrls: ["https://a/api", "https://b/api"], retry: { 500: { attempts: 0 } } });
    fetchMock.mockResolvedValueOnce(res(500));
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    expect(out.response.status).toBe(500);
    expect(out.url).toBe("https://a/api");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("P1 #4 — instant failover (skip delay when alternatives exist)", () => {
  it("skips retry delay on 502 when alternative URL exists", async () => {
    const sleepSpy = vi.spyOn(global, "setTimeout");
    const ex = makeExec({ baseUrls: ["https://a/api", "https://b/api"], retry: { 502: { attempts: 3, delayMs: 5000 } } });
    fetchMock
      .mockResolvedValueOnce(res(502))
      .mockResolvedValueOnce(res(200));
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    expect(out.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Verify no long sleep was scheduled (only connect timer timeouts, not retry delays)
    const longSleeps = sleepSpy.mock.calls.filter(([ms]) => ms >= 1000);
    expect(longSleeps).toHaveLength(0);
    sleepSpy.mockRestore();
  });

  it("skips retry delay on network error when alternative URL exists", async () => {
    const sleepSpy = vi.spyOn(global, "setTimeout");
    const ex = makeExec({ baseUrls: ["https://a/api", "https://b/api"], retry: { 502: { attempts: 3, delayMs: 5000 } } });
    fetchMock
      .mockImplementationOnce(async () => { throw new Error("ECONNRESET"); })
      .mockResolvedValueOnce(res(200));
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    expect(out.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const longSleeps = sleepSpy.mock.calls.filter(([ms]) => ms >= 1000);
    expect(longSleeps).toHaveLength(0);
    sleepSpy.mockRestore();
  });

  it("still applies backoff on single URL (no alternative)", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 502: { attempts: 2, delayMs: 10 } } });
    fetchMock
      .mockResolvedValueOnce(res(502))
      .mockResolvedValueOnce(res(200));
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    expect(out.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.attemptedRetries).toBe(1);
  });

  it("URL-fallback takes priority over same-URL retry", async () => {
    const ex = makeExec({ baseUrls: ["https://a/api", "https://b/api"], retry: { 429: { attempts: 5, delayMs: 5000 } } });
    fetchMock
      .mockResolvedValueOnce(res(429))
      .mockResolvedValueOnce(res(200));
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    expect(out.response.status).toBe(200);
    expect(out.url).toBe("https://b/api");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // No same-URL retry happened — went straight to URL[1]
    expect(out.attemptedRetries).toBe(0);
  });
});
