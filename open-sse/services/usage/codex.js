/**
 * usage/codex.ts — Codex (OpenAI / ChatGPT backend) usage fetcher.
 *
 * Extracted from services/usage.ts (god-file decomposition): the Codex family — the ChatGPT
 * backend usage-API config and the getCodexUsage fetcher that reads the persisted workspace
 * binding and shapes quotas via buildCodexUsageQuotas. Depends only on the scalar leaf +
 * codexUsageQuotas — no host coupling — so it lives as a co-located provider leaf. usage.ts
 * imports getCodexUsage (dispatcher). Behavior-preserving move.
 */

import { buildCodexUsageQuotas } from "../codexUsageQuotas";
import { getFieldValue } from "./scalars";
import { proxyAwareFetch } from "../../utils/proxyFetch";

function toFiniteNumber(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

// Codex (OpenAI) API config
const CODEX_CONFIG = {
  usageUrl: "https://chatgpt.com/backend-api/wham/usage",
  resetCreditsConsumeUrl: "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume"
};

/**
 * Codex (OpenAI) Usage - Fetch from ChatGPT backend API
 * IMPORTANT: Uses persisted workspaceId from OAuth to ensure correct workspace binding.
 * No fallback to other workspaces - strict binding to user's selected workspace.
 */
export async function getCodexUsage(accessToken, providerSpecificData = {}) {
  try {
    // Use persisted workspace ID from OAuth - NO FALLBACK
    const accountId = typeof providerSpecificData.workspaceId === "string" ? providerSpecificData.workspaceId : null;
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    };
    if (accountId) {
      headers["chatgpt-account-id"] = accountId;
    }
    const response = await fetch(CODEX_CONFIG.usageUrl, {
      method: "GET",
      headers
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return {
          message: `Codex token expired or access denied. Please re-authenticate the connection.`
        };
      }
      throw new Error(`Codex API error: ${response.status}`);
    }
    const data = await response.json();
    const {
      rateLimit,
      quotas
    } = buildCodexUsageQuotas(data);
    return {
      plan: String(getFieldValue(data, "plan_type", "planType") || "unknown"),
      limitReached: Boolean(getFieldValue(rateLimit, "limit_reached", "limitReached")),
      quotas
    };
  } catch (error) {
    return {
      message: `Failed to fetch Codex usage: ${error.message}`
    };
  }
}

export async function consumeCodexRateLimitResetCredit(accessToken, redeemRequestId, proxyOptions = null) {
  if (!accessToken) {
    throw new Error("No Codex access token available. Please re-authorize the connection.");
  }
  if (!redeemRequestId || typeof redeemRequestId !== "string") {
    throw new Error("A redeem request id is required to consume a Codex reset credit.");
  }

  let response;
  let data = null;
  try {
    response = await proxyAwareFetch(CODEX_CONFIG.resetCreditsConsumeUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Accept": "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ redeem_request_id: redeemRequestId }),
    }, proxyOptions);

    const text = await response.text();
    data = text ? JSON.parse(text) : null;
  } catch (error) {
    throw new Error(`Failed to consume Codex reset credit: ${error.message}`);
  }

  const code = data?.code || null;
  const windowsReset = toFiniteNumber(data?.windows_reset, 0);
  const success = response.ok && (code === "reset" || windowsReset > 0);

  return {
    ok: success,
    noCredit: response.ok && code === "no_credit",
    status: response.status,
    code,
    windowsReset,
    message: data?.message || null,
    raw: data,
  };
}