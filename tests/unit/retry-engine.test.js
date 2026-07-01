import { describe, it, expect } from "vitest";
import { RetryEngine } from "../../open-sse/utils/retryEngine.js";
import { BACKOFF_CONFIG, HTTP_STATUS } from "../../open-sse/config/runtimeConfig.js";

function res(status, headers = {}) {
  return {
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null }
  };
}

describe("RetryEngine", () => {
  it("normalizes numeric config entries", () => {
    const engine = new RetryEngine({ perStatusConfig: { 429: 2 } });
    const cfg = engine.getConfig(429);
    expect(cfg.attempts).toBe(2);
    expect(cfg.delayMs).toBe(2000);
    expect(cfg.backoff).toBe("fixed");
  });

  it("refuses to retry 400/401/403 even when configured", async () => {
    const engine = new RetryEngine({
      perStatusConfig: {
        [HTTP_STATUS.BAD_REQUEST]: { attempts: 5 },
        [HTTP_STATUS.UNAUTHORIZED]: { attempts: 5 },
        [HTTP_STATUS.FORBIDDEN]: { attempts: 5 }
      }
    });
    for (const status of [400, 401, 403]) {
      const plan = await engine.plan({ status, attempt: 1 });
      expect(plan.retry).toBe(false);
      expect(plan.reason).toBe("non-retryable-status");
    }
  });

  it("429 with exponential_jitter uses injected random source", async () => {
    const engine = new RetryEngine({
      perStatusConfig: {
        429: { attempts: 3, delayMs: 1000, backoff: "exponential_jitter" }
      },
      random: () => 0.5
    });
    // attempt 1 => base = 1000, partial jitter => base/2 + 0.5 * (base/2) = 750
    const plan = await engine.plan({ status: 429, attempt: 1 });
    expect(plan.retry).toBe(true);
    expect(plan.delayMs).toBe(750);
    expect(plan.reason).toBe("exponential_jitter");
    expect(plan.maxRetries).toBe(3);
  });

  it("exponential backoff doubles each attempt", async () => {
    const engine = new RetryEngine({
      perStatusConfig: {
        503: { attempts: 4, delayMs: 1000, backoff: "exponential" }
      }
    });
    expect((await engine.plan({ status: 503, attempt: 1 })).delayMs).toBe(1000);
    expect((await engine.plan({ status: 503, attempt: 2 })).delayMs).toBe(2000);
    expect((await engine.plan({ status: 503, attempt: 3 })).delayMs).toBe(4000);
  });

  it("fixed backoff repeats the configured delay", async () => {
    const engine = new RetryEngine({
      perStatusConfig: {
        502: { attempts: 2, delayMs: 3000, backoff: "fixed" }
      }
    });
    const p1 = await engine.plan({ status: 502, attempt: 1 });
    const p2 = await engine.plan({ status: 502, attempt: 2 });
    expect(p1.delayMs).toBe(3000);
    expect(p2.delayMs).toBe(3000);
  });

  it("honors Retry-After seconds header", async () => {
    const engine = new RetryEngine({
      perStatusConfig: { 429: { attempts: 3, delayMs: 1000, backoff: "fixed" } }
    });
    const plan = await engine.plan({ status: 429, attempt: 1, response: res(429, { "retry-after": "5" }) });
    expect(plan.retry).toBe(true);
    expect(plan.delayMs).toBe(5000);
    expect(plan.reason).toBe("retry-after");
  });

  it("honors Retry-After HTTP date header", async () => {
    const engine = new RetryEngine({
      perStatusConfig: { 429: { attempts: 3, delayMs: 1000, backoff: "fixed" } }
    });
    const future = new Date(Date.now() + 10000).toUTCString();
    const plan = await engine.plan({ status: 429, attempt: 1, response: res(429, { "retry-after": future }) });
    expect(plan.retry).toBe(true);
    // Allow small clock skew in the test runner.
    expect(plan.delayMs).toBeGreaterThanOrEqual(9000);
    expect(plan.delayMs).toBeLessThanOrEqual(12000);
  });

  it("caps Retry-After at maxDelayMs", async () => {
    const engine = new RetryEngine({
      perStatusConfig: { 429: { attempts: 3, delayMs: 1000, backoff: "fixed" } },
      maxDelayMs: 5000
    });
    const plan = await engine.plan({ status: 429, attempt: 1, response: res(429, { "retry-after": "60" }) });
    expect(plan.delayMs).toBe(5000);
  });

  it("stops when attempts are exhausted", async () => {
    const engine = new RetryEngine({
      perStatusConfig: { 502: { attempts: 2, delayMs: 0, backoff: "fixed" } }
    });
    expect((await engine.plan({ status: 502, attempt: 1 })).retry).toBe(true);
    expect((await engine.plan({ status: 502, attempt: 2 })).retry).toBe(true);
    const plan3 = await engine.plan({ status: 502, attempt: 3 });
    expect(plan3.retry).toBe(false);
    expect(plan3.reason).toBe("attempts-exhausted");
  });

  it("respects global maxAttempts ceiling", async () => {
    const engine = new RetryEngine({
      maxAttempts: 1,
      perStatusConfig: { 503: { attempts: 5, delayMs: 0, backoff: "fixed" } }
    });
    expect((await engine.plan({ status: 503, attempt: 1 })).retry).toBe(true);
    expect((await engine.plan({ status: 503, attempt: 2 })).retry).toBe(false);
  });

  it("returns no-retry-config for unconfigured statuses", async () => {
    const engine = new RetryEngine({ perStatusConfig: {} });
    const plan = await engine.plan({ status: 500, attempt: 1 });
    expect(plan.retry).toBe(false);
    expect(plan.reason).toBe("no-retry-config");
  });

  it("customDelay override is used when it returns a number", async () => {
    const engine = new RetryEngine({
      perStatusConfig: { 429: { attempts: 2, delayMs: 1000, backoff: "fixed" } }
    });
    const plan = await engine.plan({
      status: 429,
      attempt: 1,
      customDelay: () => 1234
    });
    expect(plan.delayMs).toBe(1234);
    expect(plan.reason).toBe("custom-delay");
  });

  it("customDelay returning false vetoes retry", async () => {
    const engine = new RetryEngine({
      perStatusConfig: { 429: { attempts: 5, delayMs: 0, backoff: "fixed" } }
    });
    const plan = await engine.plan({
      status: 429,
      attempt: 1,
      customDelay: () => false
    });
    expect(plan.retry).toBe(false);
    expect(plan.reason).toBe("custom-delay-veto");
  });

  it("customDelay returning null falls through to policy", async () => {
    const engine = new RetryEngine({
      perStatusConfig: { 503: { attempts: 2, delayMs: 777, backoff: "fixed" } }
    });
    const plan = await engine.plan({
      status: 503,
      attempt: 1,
      customDelay: () => null
    });
    expect(plan.retry).toBe(true);
    expect(plan.delayMs).toBe(777);
  });

  it("parseRetryAfter handles seconds and dates", () => {
    const engine = new RetryEngine({});
    expect(engine.parseRetryAfter(res(429, { "retry-after": "3" }))).toBe(3000);
    expect(engine.parseRetryAfter(res(429, { "retry-after": "0" }))).toBe(0);
    const future = new Date(Date.now() + 12000).toUTCString();
    const parsed = engine.parseRetryAfter(res(429, { "retry-after": future }));
    expect(parsed).toBeGreaterThanOrEqual(11000);
    expect(engine.parseRetryAfter(res(429, {}))).toBeNull();
  });

  it("parseRetryAfter supports x-ratelimit-reset-after", () => {
    const engine = new RetryEngine({});
    expect(engine.parseRetryAfter(res(429, { "x-ratelimit-reset-after": "4" }))).toBe(4000);
  });

  it("parseRetryAfter supports x-ratelimit-reset timestamp", () => {
    const engine = new RetryEngine({});
    const tsSec = Math.ceil(Date.now() / 1000) + 6;
    expect(engine.parseRetryAfter(res(429, { "x-ratelimit-reset": String(tsSec) }))).toBeGreaterThanOrEqual(5000);
  });

  it("caps computed backoff at maxDelayMs", async () => {
    const engine = new RetryEngine({
      maxDelayMs: 10000,
      perStatusConfig: { 429: { attempts: 10, delayMs: 1000, backoff: "exponential" } }
    });
    const plan = await engine.plan({ status: 429, attempt: 10 });
    expect(plan.delayMs).toBe(10000);
  });

  it("uses BACKOFF_CONFIG.max as default maxDelayMs", () => {
    const engine = new RetryEngine({ perStatusConfig: {} });
    expect(engine.maxDelayMs).toBe(BACKOFF_CONFIG.max);
  });
});
