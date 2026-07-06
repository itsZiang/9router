/**
 * quotaPreflight.ts — Feature 04
 * Quota Preflight & Troca Proativa de Conta
 *
 * Providers register quota fetchers via registerQuotaFetcher(). The caller
 * (`src/sse/services/auth.ts::getProviderCredentialsWithQuotaPreflight`) is
 * responsible for deciding WHEN to invoke preflight — calling it adds the
 * latency of an upstream usage fetch, so it should only run when there's
 * something to enforce (per-connection overrides, per-(provider, window)
 * defaults, or the legacy `quotaPreflightEnabled` flag).
 *
 * Threshold semantics are "minimum remaining %" — matching the dashboard's
 * quota bars, which show remaining (not used). A cutoff of 10 means "stop
 * using this connection when it has 10% or less remaining."
 *
 * `isQuotaPreflightEnabled` remains exported for back-compat so the caller
 * can honor the legacy flag, but `preflightQuota` itself no longer gates on
 * it — once you invoke preflight, it runs the fetcher and evaluates.
 */

/**
 * Registry of named quota windows per provider. Used by the dashboard to
 * discover which inputs to render in the cutoffs modal. Providers without
 * multiple windows can skip registration — preflight falls back to the
 * single-signal `percentUsed` path in that case.
 */
const quotaWindowsRegistry = new Map();
export function registerQuotaWindows(provider, windows) {
  quotaWindowsRegistry.set(provider, [...windows]);
}
export function getQuotaWindows(provider) {
  return quotaWindowsRegistry.get(provider) || quotaWindowsRegistry.get(provider.toLowerCase()) || [];
}
export function getAllProviderQuotaWindows() {
  return Object.fromEntries(quotaWindowsRegistry);
}

// Thresholds use "minimum remaining %" semantics so the numbers match the
// dashboard's quota bars (which show remaining %). A cutoff of 2 means
// "block when only 2% remaining" (= 98% used). Warn fires earlier — at
// 20% remaining (= 80% used) by default.
const DEFAULT_MIN_REMAINING_PERCENT = 2;
const DEFAULT_WARN_REMAINING_PERCENT = 20;
const REMAINING_PERCENT_EPSILON = 1e-9;
const quotaFetcherRegistry = new Map();
export function registerQuotaFetcher(provider, fetcher) {
  quotaFetcherRegistry.set(provider, fetcher);
}
export function getQuotaFetcher(provider) {
  return quotaFetcherRegistry.get(provider) || quotaFetcherRegistry.get(provider.toLowerCase());
}
export function isQuotaPreflightEnabled(connection) {
  const psd = connection?.providerSpecificData;
  return psd?.quotaPreflightEnabled === true;
}
function resolveOrDefault(resolver, window, fallbackPercent) {
  if (!resolver) return fallbackPercent;
  const raw = resolver(window);
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 100) {
    return raw;
  }
  return fallbackPercent;
}
function remainingPercentFrom(percentUsed) {
  return Math.max(0, (1 - percentUsed) * 100);
}
function isRemainingAtOrBelowThreshold(remainingPercent, thresholdPercent) {
  return remainingPercent <= thresholdPercent + REMAINING_PERCENT_EPSILON;
}
function exhaustedResult(quotaPercent, resetAt) {
  return {
    proceed: false,
    reason: "quota_exhausted",
    quotaPercent,
    resetAt
  };
}
function quotaWindowCutoffResult(windows, thresholds) {
  let worstUsedPercent = 0;
  let worstWindow = null;
  let worstResetAt = null;
  for (const [windowName, windowInfo] of Object.entries(windows)) {
    if (!Number.isFinite(windowInfo.percentUsed)) continue;
    const minRemainingPercent = resolveOrDefault(thresholds?.resolveMinRemainingPercent, windowName, DEFAULT_MIN_REMAINING_PERCENT);
    if (!isRemainingAtOrBelowThreshold(remainingPercentFrom(windowInfo.percentUsed), minRemainingPercent)) {
      continue;
    }
    if (windowInfo.percentUsed <= worstUsedPercent && worstWindow !== null) continue;
    worstUsedPercent = windowInfo.percentUsed;
    worstWindow = windowName;
    worstResetAt = windowInfo.resetAt ?? null;
  }
  return worstWindow === null ? null : exhaustedResult(worstUsedPercent, worstResetAt);
}
function quotaPercentCutoffResult(quota, thresholds) {
  if (!Number.isFinite(quota.percentUsed)) return {
    proceed: true
  };
  const minRemainingPercent = resolveOrDefault(thresholds?.resolveMinRemainingPercent, null, DEFAULT_MIN_REMAINING_PERCENT);
  const remainingPercent = remainingPercentFrom(quota.percentUsed);
  return isRemainingAtOrBelowThreshold(remainingPercent, minRemainingPercent) ? exhaustedResult(quota.percentUsed, quota.resetAt ?? null) : {
    proceed: true,
    quotaPercent: quota.percentUsed
  };
}

/**
 * Pure cutoff evaluator used by routing paths that already fetched quota.
 * Mirrors preflightQuota threshold semantics without performing I/O or logging.
 */
export function evaluateQuotaCutoff(quota, thresholds) {
  if (!quota) return {
    proceed: true
  };
  if (quota.limitReached === true) return exhaustedResult(1, quota.resetAt ?? null);
  const windows = quota.windows;
  if (windows && Object.keys(windows).length > 0) {
    return quotaWindowCutoffResult(windows, thresholds) ?? {
      proceed: true,
      quotaPercent: quota.percentUsed
    };
  }
  return quotaPercentCutoffResult(quota, thresholds);
}
export async function preflightQuota(provider, connectionId, connection, thresholds) {
  // No legacy enable-flag gate here — the caller decides when to invoke us
  // (see file-level docstring). When there's no fetcher we proceed silently.
  const fetcher = getQuotaFetcher(provider);
  if (!fetcher) {
    return {
      proceed: true
    };
  }
  let quota = null;
  try {
    quota = await fetcher(connectionId, connection);
  } catch {
    return {
      proceed: true
    };
  }
  if (!quota) {
    return {
      proceed: true
    };
  }

  // Per-window evaluation — only when the fetcher surfaces a windows map.
  // We block as soon as ANY single window's remaining quota drops to its
  // configured cutoff or below; warnings are logged independently per window.
  if (quota.windows && Object.keys(quota.windows).length > 0) {
    let worstUsedPercent = 0;
    let worstWindow = null;
    let worstResetAt = null;
    for (const [windowName, windowInfo] of Object.entries(quota.windows)) {
      const minRemainingPercent = resolveOrDefault(thresholds?.resolveMinRemainingPercent, windowName, DEFAULT_MIN_REMAINING_PERCENT);
      const warnRemainingPercent = resolveOrDefault(thresholds?.resolveWarnRemainingPercent, windowName, DEFAULT_WARN_REMAINING_PERCENT);
      const remainingPercent = remainingPercentFrom(windowInfo.percentUsed);
      if (isRemainingAtOrBelowThreshold(remainingPercent, minRemainingPercent)) {
        // Track the most-depleted blocking window so the response can name it.
        if (windowInfo.percentUsed > worstUsedPercent) {
          worstUsedPercent = windowInfo.percentUsed;
          worstWindow = windowName;
          worstResetAt = windowInfo.resetAt ?? null;
        } else if (worstWindow === null) {
          worstWindow = windowName;
          worstResetAt = windowInfo.resetAt ?? null;
        }
      } else if (isRemainingAtOrBelowThreshold(remainingPercent, warnRemainingPercent)) {
        console.warn(`[QuotaPreflight] ${provider}/${connectionId} ${windowName}: ${remainingPercent.toFixed(1)}% remaining — approaching cutoff`);
      }
    }
    if (worstWindow !== null) {
      const worstRemaining = remainingPercentFrom(worstUsedPercent);
      console.info(`[QuotaPreflight] ${provider}/${connectionId} ${worstWindow}: ${worstRemaining.toFixed(1)}% remaining — switching`);
      return {
        proceed: false,
        reason: "quota_exhausted",
        quotaPercent: worstUsedPercent,
        resetAt: worstResetAt
      };
    }
    return {
      proceed: true,
      quotaPercent: quota.percentUsed
    };
  }

  // Legacy single-signal path for fetchers that don't expose per-window data.
  const minRemainingPercent = resolveOrDefault(thresholds?.resolveMinRemainingPercent, null, DEFAULT_MIN_REMAINING_PERCENT);
  const warnRemainingPercent = resolveOrDefault(thresholds?.resolveWarnRemainingPercent, null, DEFAULT_WARN_REMAINING_PERCENT);
  const {
    percentUsed
  } = quota;
  const remainingPercent = remainingPercentFrom(percentUsed);
  if (isRemainingAtOrBelowThreshold(remainingPercent, minRemainingPercent)) {
    console.info(`[QuotaPreflight] ${provider}/${connectionId}: ${remainingPercent.toFixed(1)}% remaining — switching (cutoff ${minRemainingPercent}%)`);
    return {
      proceed: false,
      reason: "quota_exhausted",
      quotaPercent: percentUsed,
      resetAt: quota.resetAt ?? null
    };
  }
  if (isRemainingAtOrBelowThreshold(remainingPercent, warnRemainingPercent)) {
    console.warn(`[QuotaPreflight] ${provider}/${connectionId}: ${remainingPercent.toFixed(1)}% remaining — approaching cutoff`);
  }
  return {
    proceed: true,
    quotaPercent: percentUsed
  };
}