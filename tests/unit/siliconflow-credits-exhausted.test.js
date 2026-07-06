import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { classifyProviderError, PROVIDER_ERROR_TYPES } from "../../open-sse/services/errorClassifier.js";
import { hasPerModelQuota, isCreditsExhausted } from "../../open-sse/services/accountFallback.js";

describe("siliconflow credits exhausted auto-disable", () => {
  const message = "Sorry, your account balance is insufficient";

  it("detects the siliconflow balance-insufficient message", () => {
    expect(isCreditsExhausted(message)).toBe(true);
  });

  it("detects credits-exhausted inside a JSON upstream error body", () => {
    const body = JSON.stringify({ error: { message, code: "AccountBalanceInsufficient" } });
    expect(isCreditsExhausted(body)).toBe(true);
  });

  it("classifies 403 + balance insufficient as QUOTA_EXHAUSTED for siliconflow", () => {
    const type = classifyProviderError(403, message, "siliconflow");
    expect(type).toBe(PROVIDER_ERROR_TYPES.QUOTA_EXHAUSTED);
  });

  it("classifies 402 + balance insufficient as QUOTA_EXHAUSTED for siliconflow", () => {
    const type = classifyProviderError(402, message, "siliconflow");
    expect(type).toBe(PROVIDER_ERROR_TYPES.QUOTA_EXHAUSTED);
  });

  it("built-in siliconflow entry is NOT treated as per-model quota provider", () => {
    // If this were true, QUOTA_EXHAUSTED would lock only the model instead of disabling the connection.
    expect(hasPerModelQuota("siliconflow", "some-model")).toBe(false);
  });

  it("custom openai-compatible-siliconflow IS treated as per-model quota provider", () => {
    // This is the current behavior: any provider with the openai-compatible- prefix
    // is assumed to have per-model quotas, so a credits-exhausted error only locks the model.
    expect(hasPerModelQuota("openai-compatible-siliconflow", "some-model")).toBe(true);
  });

  it("openai-compatible prefixed provider still classifies 403 as QUOTA_EXHAUSTED", () => {
    const type = classifyProviderError(403, message, "openai-compatible-siliconflow");
    expect(type).toBe(PROVIDER_ERROR_TYPES.QUOTA_EXHAUSTED);
  });

  it("chatCore QUOTA_EXHAUSTED branch checks isCreditsExhausted before per-model quota lock", () => {
    const source = fs.readFileSync(path.resolve("open-sse/handlers/chatCore.js"), "utf-8");
    const quotaBranchIdx = source.indexOf("errorType === PROVIDER_ERROR_TYPES.QUOTA_EXHAUSTED");
    expect(quotaBranchIdx).toBeGreaterThan(-1);

    // The branch must call isCreditsExhausted so account-level balance exhaustion
    // (SiliconFlow "balance is insufficient") bypasses the per-model quota lock
    // and disables the whole connection instead.
    const branchSlice = source.slice(quotaBranchIdx, quotaBranchIdx + 2500);
    expect(branchSlice).toContain("isCreditsExhausted");

    // And the check must happen before lockModelIfPerModelQuota is consulted.
    const creditsCheckIdx = branchSlice.indexOf("isCreditsExhausted");
    const lockModelIdx = branchSlice.indexOf("lockModelIfPerModelQuota");
    expect(creditsCheckIdx).toBeGreaterThan(-1);
    expect(lockModelIdx).toBeGreaterThan(-1);
    expect(creditsCheckIdx).toBeLessThan(lockModelIdx);
  });
});
