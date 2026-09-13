// Regression: Zen long-reasoning timeouts must match the official CLI budget
// (300s), not the 30s/45s stub defaults that aborted healthy muse-spark
// streams mid-reasoning as `terminated`.
import { describe, it, expect } from "vitest";
import {
  isLongLivedUpstreamHostname,
  getLongLivedBodyTimeoutMs,
  __getLongLivedDispatcherOptionsForTest,
  __getDefaultDispatcherOptionsForTest,
} from "../../open-sse/utils/proxyDispatcher.js";
import { resolveStreamReadinessTimeout } from "../../open-sse/utils/streamReadinessPolicy.js";

describe("long-lived dispatcher routing", () => {
  it("matches opencode.ai and subdomains only", () => {
    expect(isLongLivedUpstreamHostname("opencode.ai")).toBe(true);
    expect(isLongLivedUpstreamHostname("zen.opencode.ai")).toBe(true);
    expect(isLongLivedUpstreamHostname("OPencode.AI")).toBe(true);
    expect(isLongLivedUpstreamHostname("api.openai.com")).toBe(false);
    expect(isLongLivedUpstreamHostname("fakeopencode.ai")).toBe(false);
    expect(isLongLivedUpstreamHostname("")).toBe(false);
    expect(isLongLivedUpstreamHostname(null)).toBe(false);
  });

  it("defaults bodyTimeout to 300s and clamps above it", () => {
    const saved = process.env.OMNIROUTE_OPENCODE_BODY_TIMEOUT_MS;
    try {
      delete process.env.OMNIROUTE_OPENCODE_BODY_TIMEOUT_MS;
      expect(getLongLivedBodyTimeoutMs()).toBe(300_000);
      process.env.OMNIROUTE_OPENCODE_BODY_TIMEOUT_MS = "99999999";
      expect(getLongLivedBodyTimeoutMs()).toBe(300_000);
      process.env.OMNIROUTE_OPENCODE_BODY_TIMEOUT_MS = "garbage";
      expect(getLongLivedBodyTimeoutMs()).toBe(300_000);
      process.env.OMNIROUTE_OPENCODE_BODY_TIMEOUT_MS = "60000";
      expect(getLongLivedBodyTimeoutMs()).toBe(60_000);
    } finally {
      if (saved === undefined) delete process.env.OMNIROUTE_OPENCODE_BODY_TIMEOUT_MS;
      else process.env.OMNIROUTE_OPENCODE_BODY_TIMEOUT_MS = saved;
    }
  });

  it("long-lived pool allows 300s silence while the default pool stays at 30s", () => {
    expect(__getLongLivedDispatcherOptionsForTest().bodyTimeout).toBe(300_000);
    expect(__getDefaultDispatcherOptionsForTest().bodyTimeout).toBe(30_000);
  });
});

describe("muse-spark readiness budget", () => {
  const base = { baseTimeoutMs: 45_000, maxTimeoutMs: 90_000, body: { messages: [{ role: "user", content: "hi" }] } };

  it("floors muse-spark on opencode-zen at 300s", () => {
    const out = resolveStreamReadinessTimeout({ ...base, provider: "opencode-zen", model: "muse-spark-1.3-contributor-free" });
    expect(out.timeoutMs).toBe(300_000);
    expect(out.reasons).toContain("muse_spark_long_reasoning");
  });

  it("matches future muse-spark ids and oc/opencode aliases", () => {
    for (const provider of ["oc", "opencode", "opencode-go"]) {
      const out = resolveStreamReadinessTimeout({ ...base, provider, model: "muse-spark-9.9-contributor-free" });
      expect(out.timeoutMs).toBe(300_000);
    }
  });

  it("leaves other providers/models on the adaptive budget", () => {
    const other = resolveStreamReadinessTimeout({ ...base, provider: "opencode-zen", model: "big-pickle" });
    expect(other.timeoutMs).toBeLessThanOrEqual(90_000);
    expect(other.reasons).not.toContain("muse_spark_long_reasoning");
    const openai = resolveStreamReadinessTimeout({ ...base, provider: "openai", model: "muse-spark-1.3-contributor-free" });
    expect(openai.timeoutMs).toBeLessThanOrEqual(90_000);
  });
});
