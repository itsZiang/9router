import { getProviderConnections, validateApiKey, updateProviderConnection, getSettings, pullKeysFromPool, getAutoReplace, batchCreatePoolConnections } from "@/lib/localDb";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { formatRetryAfter, checkFallbackError, isModelLockActive, buildModelLockUpdate, getEarliestModelLockUntil } from "open-sse/services/accountFallback.js";
import { MAX_RATE_LIMIT_COOLDOWN_MS, QUOTA_POOL_PATTERNS } from "open-sse/config/errorConfig.js";
import { resolveProviderId, FREE_PROVIDERS } from "@/shared/constants/providers.js";
import * as log from "../utils/logger.js";

// Mutex to prevent race conditions during account selection
let selectionMutex = Promise.resolve();

// Per-connection guard: prevents duplicate auto-replace when multiple concurrent
// requests hit 403 for the same connection at the same time.
const replacingConnections = new Set();

// Cloudflare AI daily quota exhaustion pattern
const CLOUDFLARE_DAILY_QUOTA_PATTERN = "used up your daily free allocation";

// Siliconflow server busy pattern (503)
const SILICONFLOW_BUSY_PATTERN = "system is really busy";
const SILICONFLOW_BUSY_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Get the next 00:10 UTC timestamp for re-enabling Cloudflare connections.
 * If current UTC time is past 00:10, returns 00:10 UTC of the next day.
 */
function getNextCloudflareReEnableTime() {
  const now = new Date();
  const reEnable = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 10, 0, 0));
  if (reEnable.getTime() <= now.getTime()) {
    reEnable.setUTCDate(reEnable.getUTCDate() + 1);
  }
  return reEnable.toISOString();
}

/**
 * Re-enable Cloudflare connections that were disabled due to daily quota exhaustion
 * and have passed their re-enable time (00:10 UTC).
 */
async function reEnableCloudflareConnections() {
  try {
    const allConnections = await getProviderConnections({ provider: "cloudflare-ai" });
    const now = new Date().toISOString();
    const toReEnable = allConnections.filter(c => {
      const psd = c.providerSpecificData || {};
      return psd.cloudflareQuotaDisabled === true && psd.cloudflareReEnableAt && psd.cloudflareReEnableAt <= now;
    });

    if (toReEnable.length === 0) return;

    for (const conn of toReEnable) {
      const psd = { ...(conn.providerSpecificData || {}) };
      delete psd.cloudflareQuotaDisabled;
      delete psd.cloudflareReEnableAt;
      await updateProviderConnection(conn.id, { isActive: true, providerSpecificData: psd });
      const connName = conn.displayName || conn.name || conn.email || conn.id.slice(0, 8);
      log.info("AUTH", `[CLOUDFLARE] Re-enabled ${connName} — daily quota cooldown expired (was disabled until ${conn.providerSpecificData?.cloudflareReEnableAt})`);
    }
  } catch (err) {
    log.warn("AUTH", `[CLOUDFLARE] re-enable check failed: ${err.message}`);
  }
}

/**
 * Re-enable Siliconflow connections that were disabled due to server busy (503)
 * and have passed their 15-minute cooldown.
 */
async function reEnableSiliconflowConnections() {
  try {
    // Query all connections and filter by flag — Siliconflow may be registered
    // as built-in "siliconflow" OR as an openai-compatible-* provider.
    const allConnections = await getProviderConnections({});
    const now = new Date().toISOString();
    const toReEnable = allConnections.filter(c => {
      const psd = c.providerSpecificData || {};
      return psd.siliconflowBusyDisabled === true && psd.siliconflowReEnableAt && psd.siliconflowReEnableAt <= now;
    });

    if (toReEnable.length === 0) return;

    for (const conn of toReEnable) {
      const psd = { ...(conn.providerSpecificData || {}) };
      delete psd.siliconflowBusyDisabled;
      delete psd.siliconflowReEnableAt;
      await updateProviderConnection(conn.id, { isActive: true, providerSpecificData: psd });
      const connName = conn.displayName || conn.name || conn.email || conn.id.slice(0, 8);
      log.info("AUTH", `[SILICONFLOW] Re-enabled ${connName} — server busy cooldown expired (was disabled until ${conn.providerSpecificData?.siliconflowReEnableAt})`);
    }
  } catch (err) {
    log.warn("AUTH", `[SILICONFLOW] re-enable check failed: ${err.message}`);
  }
}

/**
 * Get provider credentials from localDb
 * Filters out unavailable accounts and returns the selected account based on strategy
 * @param {string} provider - Provider name
 * @param {Set<string>|string|null} excludeConnectionIds - Connection ID(s) to exclude (for retry with next account)
 * @param {string|null} model - Model name for per-model rate limit filtering
 */
export async function getProviderCredentials(provider, excludeConnectionIds = null, model = null, options = {}) {
  // Normalize to Set for consistent handling
  const excludeSet = excludeConnectionIds instanceof Set
    ? excludeConnectionIds
    : (excludeConnectionIds ? new Set([excludeConnectionIds]) : new Set());
  const preferredConnectionId = options?.preferredConnectionId || null;
  // Acquire mutex to prevent race conditions
  const currentMutex = selectionMutex;
  let resolveMutex;
  selectionMutex = new Promise(resolve => { resolveMutex = resolve; });

  try {
    await currentMutex;

    // Re-enable Cloudflare connections that passed their daily quota cooldown
    await reEnableCloudflareConnections();

    // Re-enable Siliconflow connections that passed their 15-min server busy cooldown
    await reEnableSiliconflowConnections();

    // Resolve alias to provider ID (e.g., "kc" -> "kilocode")
    const providerId = resolveProviderId(provider);

    // Inject a virtual connection for no-auth free providers (with optional proxy pool from settings)
    if (FREE_PROVIDERS[providerId]?.noAuth) {
      const settings = await getSettings();
      const override = (settings.providerStrategies || {})[providerId] || {};
      const resolvedProxy = await resolveConnectionProxyConfig({ proxyPoolId: override.proxyPoolId || "" });
      return {
        id: "noauth",
        connectionName: "Public",
        isActive: true,
        accessToken: "public",
        providerSpecificData: {
          connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
          connectionProxyUrl: resolvedProxy.connectionProxyUrl,
          connectionNoProxy: resolvedProxy.connectionNoProxy,
          connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
          vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
          strictProxy: resolvedProxy.strictProxy === true,
        },
      };
    }

    const connections = await getProviderConnections({ provider: providerId, isActive: true });
    log.debug("AUTH", `${provider} | total connections: ${connections.length}, excludeIds: ${excludeSet.size > 0 ? [...excludeSet].join(",") : "none"}, model: ${model || "any"}`);

    if (connections.length === 0) {
      log.warn("AUTH", `No credentials for ${provider}`);
      return null;
    }

    // Filter out model-locked and excluded connections
    const availableConnections = connections.filter(c => {
      if (excludeSet.has(c.id)) return false;
      if (isModelLockActive(c, model)) return false;
      return true;
    });

    log.debug("AUTH", `${provider} | available: ${availableConnections.length}/${connections.length}`);
    connections.forEach(c => {
      const excluded = excludeSet.has(c.id);
      const locked = isModelLockActive(c, model);
      if (excluded || locked) {
        const lockUntil = getEarliestModelLockUntil(c);
        log.debug("AUTH", `  → ${c.id?.slice(0, 8)} | ${excluded ? "excluded" : ""} ${locked ? `modelLocked(${model}) until ${lockUntil}` : ""}`);
      }
    });

    if (availableConnections.length === 0) {
      // Find earliest lock expiry across all connections for retry timing
      const lockedConns = connections.filter(c => isModelLockActive(c, model));
      const expiries = lockedConns.map(c => getEarliestModelLockUntil(c)).filter(Boolean);
      const earliest = expiries.sort()[0] || null;
      if (earliest) {
        const earliestConn = lockedConns[0];
        log.warn("AUTH", `${provider} | all ${connections.length} accounts locked for ${model || "all"} (${formatRetryAfter(earliest)}) | lastError=${earliestConn?.lastError?.slice(0, 50)}`);
        return {
          allRateLimited: true,
          retryAfter: earliest,
          retryAfterHuman: formatRetryAfter(earliest),
          lastError: earliestConn?.lastError || null,
          lastErrorCode: earliestConn?.errorCode || null
        };
      }
      log.warn("AUTH", `${provider} | all ${connections.length} accounts unavailable`);
      return null;
    }

    const settings = await getSettings();
    // Per-provider strategy overrides global setting
    const providerOverride = (settings.providerStrategies || {})[providerId] || {};
    const strategy = providerOverride.fallbackStrategy || settings.fallbackStrategy || "fill-first";

    let connection;
    // Pin to preferred connection if specified and available
    if (preferredConnectionId) {
      connection = availableConnections.find((c) => c.id === preferredConnectionId);
      if (connection) {
        log.info("AUTH", `${provider} | pinned to ${connection.id?.slice(0, 8)} (${connection.name || connection.email || "unnamed"})`);
      }
    }
    if (connection) {
      // skip strategy
    } else if (strategy === "round-robin") {
      const stickyLimit = providerOverride.stickyRoundRobinLimit || settings.stickyRoundRobinLimit || 3;

      // Sort by lastUsed (most recent first) to find current candidate
      const byRecency = [...availableConnections].sort((a, b) => {
        if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
        if (!a.lastUsedAt) return 1;
        if (!b.lastUsedAt) return -1;
        return new Date(b.lastUsedAt) - new Date(a.lastUsedAt);
      });

      const current = byRecency[0];
      const currentCount = current?.consecutiveUseCount || 0;

      if (current && current.lastUsedAt && currentCount < stickyLimit) {
        // Stay with current account
        connection = current;
        // Update lastUsedAt and increment count (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: (connection.consecutiveUseCount || 0) + 1
        });
      } else {
        // Pick the least recently used (excluding current if possible)
        const sortedByOldest = [...availableConnections].sort((a, b) => {
          if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
          if (!a.lastUsedAt) return -1;
          if (!b.lastUsedAt) return 1;
          return new Date(a.lastUsedAt) - new Date(b.lastUsedAt);
        });

        connection = sortedByOldest[0];

        // Update lastUsedAt and reset count to 1 (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: 1
        });
      }
    } else {
      // Default: fill-first (already sorted by priority in getProviderConnections)
      connection = availableConnections[0];
    }

    const resolvedProxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});

    return {
      authType: connection.authType,
      apiKey: connection.apiKey,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      idToken: connection.idToken,
      expiresAt: connection.expiresAt,
      expiresIn: connection.expiresIn,
      lastRefreshAt: connection.lastRefreshAt,
      projectId: connection.projectId,
      connectionName: connection.displayName || connection.name || connection.email || connection.id,
      copilotToken: connection.providerSpecificData?.copilotToken,
      providerSpecificData: {
        ...(connection.providerSpecificData || {}),
        connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
        connectionProxyUrl: resolvedProxy.connectionProxyUrl,
        connectionNoProxy: resolvedProxy.connectionNoProxy,
        connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
        vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
        strictProxy: resolvedProxy.strictProxy === true,
      },
      connectionId: connection.id,
      // Include current status for optimization check
      testStatus: connection.testStatus,
      lastError: connection.lastError,
      // Pass full connection for clearAccountError to read modelLock_* keys
      _connection: connection
    };
  } finally {
    if (resolveMutex) resolveMutex();
  }
}

/**
 * Auto-replace a quota-exhausted connection with a fresh key from the pool.
 */
async function autoReplaceFromPool(provider, failingConnectionId) {
  // Guard: only one replace per failing connection at a time
  if (replacingConnections.has(failingConnectionId)) return;
  replacingConnections.add(failingConnectionId);

  try {
    // Run independent fetches in parallel
    const [enabled, existing] = await Promise.all([
      getAutoReplace(provider),
      getProviderConnections({ provider, isActive: true }),
    ]);
    if (!enabled) return;

    const existingKeys = existing.map((c) => c.apiKey).filter(Boolean);

    const pulled = await pullKeysFromPool(provider, 1, existingKeys);
    if (!pulled.length) {
      log.warn("AUTH", `[POOL] pool empty for ${provider}, cannot auto-replace`);
      await updateProviderConnection(failingConnectionId, { isActive: false });
      return;
    }

    // batchCreatePoolConnections avoids reorderInTx (no N×UPDATE on every auto-replace)
    // Pass existingKeys to skip the internal SELECT inside batchCreatePoolConnections
    // Pass providerSpecificData so custom providers (openai-compatible-*, anthropic-compatible-*)
    // inherit baseUrl — without this, pool connections fall back to api.openai.com / api.anthropic.com
    const inheritPsd = existing.find((c) => c.providerSpecificData?.baseUrl)?.providerSpecificData || null;
    const created = await batchCreatePoolConnections(provider, pulled, existingKeys, inheritPsd);
    if (created === 0) {
      log.warn("AUTH", `[POOL] replacement key already in connections for ${provider}`);
      // Fall through to disable the failing key — replacement already available, failing key should still be removed
    }
    await updateProviderConnection(failingConnectionId, { isActive: false });
    log.info("AUTH", `[POOL] auto-replaced key for ${provider} (created=${created})`);
  } catch (err) {
    log.warn("AUTH", `[POOL] auto-replace failed: ${err.message}`);
  } finally {
    replacingConnections.delete(failingConnectionId);
  }
}

/**
 * Mark account+model as unavailable — locks modelLock_${model} in DB.
 * All errors (429, 401, 5xx, etc.) lock per model, not per account.
 * @param {string} connectionId
 * @param {number} status - HTTP status code from upstream
 * @param {string} errorText
 * @param {string|null} provider
 * @param {string|null} model - The specific model that triggered the error
 * @returns {{ shouldFallback: boolean, cooldownMs: number }}
 */
export async function markAccountUnavailable(connectionId, status, errorText, provider = null, model = null, resetsAtMs = null) {
  if (!connectionId || connectionId === "noauth") return { shouldFallback: false, cooldownMs: 0 };
  const connections = await getProviderConnections({ provider });
  const conn = connections.find(c => c.id === connectionId);
  const backoffLevel = conn?.backoffLevel || 0;

  // Provider-specific precise cooldown (e.g. codex usage_limit_reached resets_at) overrides backoff
  let shouldFallback, cooldownMs, newBackoffLevel;
  if (resetsAtMs && resetsAtMs > Date.now()) {
    shouldFallback = true;
    cooldownMs = Math.min(resetsAtMs - Date.now(), MAX_RATE_LIMIT_COOLDOWN_MS);
    newBackoffLevel = 0;
  } else {
    ({ shouldFallback, cooldownMs, newBackoffLevel } = checkFallbackError(status, errorText, backoffLevel));
  }
  if (!shouldFallback) return { shouldFallback: false, cooldownMs: 0 };

  const reason = typeof errorText === "string" ? errorText.slice(0, 100) : "Provider error";

  // Cloudflare daily quota: disable connection until next 00:10 UTC instead of model-lock
  const isCloudflareDailyQuota = provider === "cloudflare-ai" &&
    typeof errorText === "string" &&
    errorText.toLowerCase().includes(CLOUDFLARE_DAILY_QUOTA_PATTERN);

  if (isCloudflareDailyQuota) {
    const reEnableAt = getNextCloudflareReEnableTime();
    const psd = { ...(conn?.providerSpecificData || {}), cloudflareQuotaDisabled: true, cloudflareReEnableAt: reEnableAt };
    await updateProviderConnection(connectionId, {
      isActive: false,
      providerSpecificData: psd,
      testStatus: "unavailable",
      lastError: reason,
      errorCode: status,
      lastErrorAt: new Date().toISOString(),
    });
    const connName = conn?.displayName || conn?.name || conn?.email || connectionId.slice(0, 8);
    log.warn("AUTH", `[CLOUDFLARE] ${connName} disabled due to daily quota exhaustion — will re-enable at ${reEnableAt}`);
    console.error(`❌ cloudflare-ai [${status}]: Daily quota exhausted — disabled until ${reEnableAt}`);
    return { shouldFallback: true, cooldownMs: 0 };
  }

  // Siliconflow server busy (503): disable ALL siliconflow connections for 15 minutes
  // Server-wide issue — not tied to a specific key, so disabling the entire pool.
  // Does NOT trigger auto-replace from pool (503 is not a billing/quota error).
  // Matches both built-in "siliconflow" provider and openai-compatible providers
  // pointing at Siliconflow (verified via baseUrl containing "siliconflow").
  const connBaseUrl = (conn?.providerSpecificData?.baseUrl || "").toLowerCase();
  const isSiliconflowProvider = provider === "siliconflow" ||
    (typeof provider === "string" && provider.startsWith("openai-compatible-") && connBaseUrl.includes("siliconflow"));
  const isSiliconflowBusy = isSiliconflowProvider &&
    typeof errorText === "string" &&
    errorText.toLowerCase().includes(SILICONFLOW_BUSY_PATTERN);

  if (isSiliconflowBusy) {
    const reEnableAt = new Date(Date.now() + SILICONFLOW_BUSY_COOLDOWN_MS).toISOString();
    for (const c of connections) {
      const psd = { ...(c.providerSpecificData || {}), siliconflowBusyDisabled: true, siliconflowReEnableAt: reEnableAt };
      await updateProviderConnection(c.id, {
        isActive: false,
        providerSpecificData: psd,
        testStatus: "unavailable",
        lastError: reason,
        errorCode: status,
        lastErrorAt: new Date().toISOString(),
      });
    }
    log.warn("AUTH", `[SILICONFLOW] Disabled ${connections.length} connection(s) due to server busy (503) — will re-enable at ${reEnableAt}`);
    console.error(`❌ siliconflow [${status}]: System busy — disabled ${connections.length} connection(s) until ${reEnableAt}`);
    return { shouldFallback: true, cooldownMs: 0 };
  }

  const lockUpdate = buildModelLockUpdate(model, cooldownMs);

  await updateProviderConnection(connectionId, {
    ...lockUpdate,
    testStatus: "unavailable",
    lastError: reason,
    errorCode: status,
    lastErrorAt: new Date().toISOString(),
    backoffLevel: newBackoffLevel ?? backoffLevel
  });

  const lockKey = Object.keys(lockUpdate)[0];
  const connName = conn?.displayName || conn?.name || conn?.email || connectionId.slice(0, 8);
  log.warn("AUTH", `${connName} locked ${lockKey} for ${Math.round(cooldownMs / 1000)}s [${status}]`);

  if (provider && status && reason) {
    console.error(`❌ ${provider} [${status}]: ${reason}`);
  }

  // Auto-replace from pool on quota exhaustion (billing error codes)
  const isBillingError = status === 400 || status === 402 || status === 403;
  if (isBillingError && provider) {
    const isQuotaExhausted = QUOTA_POOL_PATTERNS.some(p => reason.toLowerCase().includes(p));
    if (isQuotaExhausted) {
      autoReplaceFromPool(provider, connectionId).catch(() => {});
    } else if (status === 403) {
      log.warn("AUTH", `[POOL] 403 received but no quota pattern matched — reason: "${reason.slice(0, 80)}"`);
    }
  }

  return { shouldFallback: true, cooldownMs };
}

/**
 * Clear account error status on successful request.
 * - Clears modelLock_${model} (the model that just succeeded)
 * - Lazy-cleans any other expired modelLock_* keys
 * - Resets error state only if no active locks remain
 * @param {string} connectionId
 * @param {object} currentConnection - credentials object (has _connection) or raw connection
 * @param {string|null} model - model that succeeded
 */
export async function clearAccountError(connectionId, currentConnection, model = null) {
  if (!connectionId || connectionId === "noauth") return;
  const conn = currentConnection._connection || currentConnection;
  const now = Date.now();
  const allLockKeys = Object.keys(conn).filter(k => k.startsWith("modelLock_"));

  if (!conn.testStatus && !conn.lastError && allLockKeys.length === 0) return;

  // Keys to clear: current model's lock + all expired locks
  const keysToClear = allLockKeys.filter(k => {
    if (model && k === `modelLock_${model}`) return true; // succeeded model
    if (model && k === "modelLock___all") return true;    // account-level lock
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() <= now;   // expired
  });

  if (keysToClear.length === 0 && conn.testStatus !== "unavailable" && !conn.lastError) return;

  // Check if any active locks remain after clearing
  const remainingActiveLocks = allLockKeys.filter(k => {
    if (keysToClear.includes(k)) return false;
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() > now;
  });

  const clearObj = Object.fromEntries(keysToClear.map(k => [k, null]));

  // Only reset error state if no active locks remain
  if (remainingActiveLocks.length === 0) {
    Object.assign(clearObj, { testStatus: "active", lastError: null, lastErrorAt: null, backoffLevel: 0 });
  }

  await updateProviderConnection(connectionId, clearObj);
}

/**
 * Extract API key from request headers
 */
export function extractApiKey(request) {
  // Check Authorization header first
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  // Check Anthropic x-api-key header
  const xApiKey = request.headers.get("x-api-key");
  if (xApiKey) {
    return xApiKey;
  }

  return null;
}

/**
 * Validate API key (optional - for local use can skip)
 */
export async function isValidApiKey(apiKey) {
  if (!apiKey) return false;
  return await validateApiKey(apiKey);
}
