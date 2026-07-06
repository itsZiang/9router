/**
 * Stateful + async reset-aware / reset-window quota strategies for combo routing.
 *
 * Holds the two mutable module-level caches that back reset-aware routing
 * (`resetAwareConnectionCache` for per-provider active connections and
 * `resetAwareQuotaCache` for per-connection quota snapshots), plus the helpers
 * that read/write them and the strategy orderers. Extracted byte-identically
 * from combo.ts (QG v2 Fase 9 T5 D7b) — the larger, stateful half of the
 * reset-aware quota block. The pure scoring/window-math half lives in
 * ./quotaScoring.ts and is imported here.
 *
 * State cohesion: `resetAwareConnectionCache`, `resetAwareQuotaCache`, and
 * `MAX_RESET_AWARE_CACHE` MUST remain single instances defined once here,
 * alongside their only readers/writers (getQuotaAwareConnectionsForTarget,
 * fetchResetAwareQuotaWithCache) — never duplicate a Map.
 *
 * Cross-module state: the tie-band round-robin in orderTargetsByResetAwareQuota
 * and orderTargetsByResetWindow shares the same rrCounters Map from ./rrState.ts
 * (D7a) so reset-aware tie rotation stays consistent with round-robin routing.
 *
 * Pure leaf: this module never imports from the combo barrel.
 */

import { getRuntimeProviderProfile } from "../accountFallback";
import { PRE_SCREEN_CONCURRENCY } from "../comboConfig";
import { getQuotaFetcher } from "../quotaPreflight";
import { getCircuitBreaker } from "../../stubs/shared/utils/circuitBreaker";
import { getProviderConnections } from "../../stubs/lib/db/providers";
import { MAX_RR_COUNTERS, rrCounters } from "./rrState";
import { resolveResetAwareConfig, resolveResetWindowConfig, getResetAwareProvider, scoreResetAwareQuota, getResetWindowTimestampMs } from "./quotaScoring";
import { rankByHeadroom } from "./headroomRanking";
const RESET_AWARE_CONNECTION_CACHE_TTL_MS = 30_000;
const RESET_AWARE_QUOTA_FETCH_CONCURRENCY = 5;
const HEADROOM_SATURATION_FETCH_CONCURRENCY = 5;
const MAX_RESET_AWARE_CACHE = 200;
const resetAwareConnectionCache = new Map();
const resetAwareQuotaCache = new Map();
async function getQuotaAwareConnectionsForTarget(target, connectionCache, connectionLoadPromises, comboName, log) {
  const provider = getResetAwareProvider(target);
  if (!provider || !getQuotaFetcher(provider)) return [];
  if (!connectionCache.has(provider)) {
    const cached = resetAwareConnectionCache.get(provider);
    if (cached && Date.now() - cached.fetchedAt < RESET_AWARE_CONNECTION_CACHE_TTL_MS) {
      connectionCache.set(provider, cached.connections);
      return cached.connections;
    }
    if (!connectionLoadPromises.has(provider)) {
      connectionLoadPromises.set(provider, (async () => {
        try {
          const connections = await getProviderConnections({
            provider,
            isActive: true
          });
          const activeConnections = Array.isArray(connections) ? connections : [];
          if (!resetAwareConnectionCache.has(provider) && resetAwareConnectionCache.size >= MAX_RESET_AWARE_CACHE) {
            const oldest = resetAwareConnectionCache.keys().next().value;
            if (oldest !== undefined) resetAwareConnectionCache.delete(oldest);
          }
          resetAwareConnectionCache.set(provider, {
            connections: activeConnections,
            fetchedAt: Date.now()
          });
          return activeConnections;
        } catch (error) {
          log.warn?.("COMBO", "Reset-aware failed to load quota-aware connections.", {
            comboName,
            err: error,
            operation: "getProviderConnections",
            provider
          });
          return [];
        }
      })());
    }
    const connections = await connectionLoadPromises.get(provider);
    connectionCache.set(provider, connections);
  }
  return connectionCache.get(provider) || [];
}
function normalizeConnectionIds(value) {
  if (!Array.isArray(value)) return null;
  const ids = value.filter(connectionId => typeof connectionId === "string" && connectionId.trim().length > 0);
  return ids.length > 0 ? ids : null;
}
function filterAllowedConnectionIds(connectionIds, apiKeyAllowedConnectionIds) {
  const allowedIds = normalizeConnectionIds(apiKeyAllowedConnectionIds);
  if (!allowedIds) return connectionIds;
  const allowedSet = new Set(allowedIds);
  return connectionIds.filter(connectionId => allowedSet.has(connectionId));
}
function getTargetConnectionIds(target, connections) {
  let connectionIds;
  if (target.connectionId) {
    return [target.connectionId];
  }
  if (Array.isArray(target.allowedConnectionIds) && target.allowedConnectionIds.length > 0) {
    return target.allowedConnectionIds.filter(connectionId => typeof connectionId === "string" && connectionId.trim().length > 0);
  }
  connectionIds = connections.map(connection => typeof connection.id === "string" ? connection.id : null).filter(connectionId => !!connectionId);
  return connectionIds;
}
async function expandTargetsByQuotaAwareConnections(targets, comboName, log, apiKeyAllowedConnectionIds) {
  const connectionCache = new Map();
  const connectionLoadPromises = new Map();
  const connectionById = new Map();
  const expandedTargets = [];
  const targetsWithConnections = await Promise.all(targets.map(async target => ({
    connections: await getQuotaAwareConnectionsForTarget(target, connectionCache, connectionLoadPromises, comboName, log),
    target
  })));
  for (const {
    target,
    connections
  } of targetsWithConnections) {
    for (const connection of connections) {
      if (typeof connection.id === "string") connectionById.set(connection.id, connection);
    }
    const unrestrictedConnectionIds = getTargetConnectionIds(target, connections);
    const connectionIds = filterAllowedConnectionIds(unrestrictedConnectionIds, apiKeyAllowedConnectionIds);
    if (connectionIds.length === 0) {
      if (unrestrictedConnectionIds.length > 0 && normalizeConnectionIds(apiKeyAllowedConnectionIds)) {
        continue;
      }
      expandedTargets.push(target);
      continue;
    }
    for (const connectionId of connectionIds) {
      expandedTargets.push({
        ...target,
        connectionId,
        executionKey: target.connectionId === connectionId ? target.executionKey : `${target.executionKey}@${connectionId}`
      });
    }
  }
  return {
    connectionById,
    expandedTargets
  };
}
async function scoreQuotaAwareTargets({
  comboName,
  config,
  connectionById,
  expandedTargets,
  log,
  scoreQuota
}) {
  const quotaPromises = new Map();
  return mapWithConcurrency(expandedTargets, RESET_AWARE_QUOTA_FETCH_CONCURRENCY, async (target, index) => {
    let quota = null;
    const provider = getResetAwareProvider(target);
    const fetcher = provider ? getQuotaFetcher(provider) : null;
    if (fetcher && provider && target.connectionId) {
      const quotaKey = `${provider}:${target.connectionId}`;
      if (!quotaPromises.has(quotaKey)) {
        quotaPromises.set(quotaKey, fetchResetAwareQuotaWithCache({
          provider,
          connectionId: target.connectionId,
          connection: connectionById.get(target.connectionId),
          fetcher,
          config,
          log,
          comboName
        }));
      }
      quota = await quotaPromises.get(quotaKey);
    }
    return {
      target,
      index,
      ...scoreQuota(quota)
    };
  });
}
function rotateLeadingTies(sortedTargets, tiedTargets, key) {
  let orderedTiedTargets = tiedTargets;
  if (tiedTargets.length > 1) {
    const counter = rrCounters.get(key) || 0;
    if (!rrCounters.has(key) && rrCounters.size >= MAX_RR_COUNTERS) {
      const oldest = rrCounters.keys().next().value;
      if (oldest !== undefined) rrCounters.delete(oldest);
    }
    rrCounters.set(key, counter + 1);
    const startIndex = counter % tiedTargets.length;
    orderedTiedTargets = [...tiedTargets.slice(startIndex), ...tiedTargets.slice(0, startIndex)];
  }
  const tiedExecutionKeys = new Set(orderedTiedTargets.map(entry => entry.target.executionKey));
  return [...orderedTiedTargets, ...sortedTargets.filter(entry => !tiedExecutionKeys.has(entry.target.executionKey))];
}
async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({
    length: workerCount
  }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }));
  return results;
}
export async function fetchResetAwareQuotaWithCache({
  provider,
  connectionId,
  connection,
  fetcher,
  config,
  log,
  comboName
}) {
  const cacheKey = `${provider}:${connectionId}`;
  const ttlMs = config.quotaCacheTtlMs;
  const maxStaleMs = config.quotaCacheMaxStaleMs;
  const now = Date.now();
  const cached = resetAwareQuotaCache.get(cacheKey);
  if (ttlMs <= 0 && maxStaleMs <= 0) {
    try {
      return await fetcher(connectionId, connection);
    } catch (error) {
      log.warn?.("COMBO", "Reset-aware quota fetch failed.", {
        comboName,
        connectionId,
        err: error,
        operation: "quotaFetch",
        provider
      });
      return null;
    }
  }
  const refresh = () => {
    const existing = resetAwareQuotaCache.get(cacheKey);
    if (existing?.refreshPromise != null) return existing.refreshPromise;
    const refreshPromise = fetcher(connectionId, connection).then(quota => {
      if (quota) {
        if (!resetAwareQuotaCache.has(cacheKey) && resetAwareQuotaCache.size >= MAX_RESET_AWARE_CACHE) {
          const oldest = resetAwareQuotaCache.keys().next().value;
          if (oldest !== undefined) resetAwareQuotaCache.delete(oldest);
        }
        resetAwareQuotaCache.set(cacheKey, {
          quota,
          fetchedAt: Date.now(),
          refreshPromise: null
        });
      } else {
        resetAwareQuotaCache.delete(cacheKey);
      }
      return quota;
    }).catch(error => {
      const previous = resetAwareQuotaCache.get(cacheKey);
      if (previous) {
        if (!resetAwareQuotaCache.has(cacheKey) && resetAwareQuotaCache.size >= MAX_RESET_AWARE_CACHE) {
          const oldest = resetAwareQuotaCache.keys().next().value;
          if (oldest !== undefined) resetAwareQuotaCache.delete(oldest);
        }
        resetAwareQuotaCache.set(cacheKey, {
          ...previous,
          refreshPromise: null
        });
      }
      log.warn?.("COMBO", "Reset-aware quota fetch failed.", {
        comboName,
        connectionId,
        err: error,
        operation: "quotaFetch",
        provider
      });
      return null;
    });
    if (!resetAwareQuotaCache.has(cacheKey) && resetAwareQuotaCache.size >= MAX_RESET_AWARE_CACHE) {
      const oldest = resetAwareQuotaCache.keys().next().value;
      if (oldest !== undefined) resetAwareQuotaCache.delete(oldest);
    }
    resetAwareQuotaCache.set(cacheKey, {
      quota: existing?.quota ?? cached?.quota ?? null,
      fetchedAt: existing?.fetchedAt ?? cached?.fetchedAt ?? 0,
      refreshPromise
    });
    return refreshPromise;
  };
  if (ttlMs > 0 && cached) {
    const age = now - cached.fetchedAt;
    if (age <= ttlMs) return cached.quota;
    if (maxStaleMs > 0 && age <= ttlMs + maxStaleMs) {
      void refresh();
      return cached.quota;
    }
  }
  return refresh();
}
export async function preScreenTargets(targets, isModelAvailable) {
  if (targets.length === 0) {
    return new Map();
  }
  const results = await mapWithConcurrency(targets, PRE_SCREEN_CONCURRENCY, async target => {
    const profile = await getRuntimeProviderProfile(target.provider).catch(() => null);
    const breaker = getCircuitBreaker(target.provider);
    if (breaker.getStatus().state === "OPEN") {
      return {
        key: target.executionKey,
        result: {
          profile,
          available: false
        }
      };
    }
    let available = true;
    if (isModelAvailable) {
      // IsModelAvailable may return a sync boolean or a Promise; Promise.resolve
      // normalizes both so the .catch() never runs against a bare boolean.
      available = await Promise.resolve(isModelAvailable(target.modelStr, target)).catch(() => true);
    }
    return {
      key: target.executionKey,
      result: {
        profile,
        available
      }
    };
  });
  const map = new Map();
  for (const {
    key,
    result
  } of results) {
    map.set(key, result);
  }
  return map;
}
export async function orderTargetsByResetAwareQuota(targets, comboName, configSource, log, apiKeyAllowedConnectionIds) {
  if (targets.length === 0) return targets;
  const config = resolveResetAwareConfig(configSource);
  const {
    connectionById,
    expandedTargets
  } = await expandTargetsByQuotaAwareConnections(targets, comboName, log, apiKeyAllowedConnectionIds);
  const scoredTargets = await scoreQuotaAwareTargets({
    comboName,
    config,
    connectionById,
    expandedTargets,
    log,
    scoreQuota: quota => ({
      score: scoreResetAwareQuota(quota, config).score
    })
  });
  scoredTargets.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.index - b.index;
  });
  const bestScore = scoredTargets[0]?.score ?? 0;
  const tiedTargets = scoredTargets.filter(entry => bestScore - entry.score <= config.tieBand);
  return rotateLeadingTies(scoredTargets, tiedTargets, `reset-aware:${comboName}`).map(entry => entry.target);
}
export async function orderTargetsByResetWindow(targets, comboName, configSource, log, apiKeyAllowedConnectionIds) {
  if (targets.length === 0) return targets;
  const config = resolveResetWindowConfig(configSource);
  const {
    connectionById,
    expandedTargets
  } = await expandTargetsByQuotaAwareConnections(targets, comboName, log, apiKeyAllowedConnectionIds);
  const scoredTargets = await scoreQuotaAwareTargets({
    comboName,
    config,
    connectionById,
    expandedTargets,
    log,
    scoreQuota: quota => ({
      resetMs: getResetWindowTimestampMs(quota, config.windows)
    })
  });
  scoredTargets.sort((a, b) => {
    if (a.resetMs !== b.resetMs) return a.resetMs - b.resetMs;
    return a.index - b.index;
  });
  const bestResetMs = scoredTargets[0]?.resetMs ?? Infinity;
  if (!Number.isFinite(bestResetMs) || config.tieBandMs <= 0) {
    return scoredTargets.map(entry => entry.target);
  }
  const tiedTargets = scoredTargets.filter(entry => entry.resetMs - bestResetMs <= config.tieBandMs);
  if (tiedTargets.length <= 1) return scoredTargets.map(entry => entry.target);
  return rotateLeadingTies(scoredTargets, tiedTargets, `reset-window:${comboName}`).map(entry => entry.target);
}

/**
 * Lazily resolve getSaturation from the cross-workspace quota module. Kept as a
 * dynamic import (matching chatCore's `@/lib/quota/saturationSignals` import) so
 * this open-sse leaf has no static edge into `src/lib/quota`, and so the seam
 * stays injectable for tests via __setHeadroomSaturationFetcherForTests.
 */

let _headroomSaturationFetcherOverride = null;

/** Test-only: inject the getSaturation fetcher; pass null to restore default. */
export function __setHeadroomSaturationFetcherForTests(fetcher) {
  _headroomSaturationFetcherOverride = fetcher;
}
async function resolveHeadroomSaturationFetcher() {
  if (_headroomSaturationFetcherOverride) return _headroomSaturationFetcherOverride;
  const mod = await import("../../stubs/lib/quota/saturationSignals");
  return mod.getSaturation;
}

/**
 * Headroom-aware ordering: prefer the connection with the MOST free capacity,
 * where headroom = 1 − max(util_5h, util_7d). The per-connection 5h / weekly
 * saturation comes from getSaturation (src/lib/quota/saturationSignals.ts); the
 * pure ranking is delegated to rankByHeadroom (./headroomRanking.ts).
 *
 * Targets are first expanded across their candidate connections (same machinery
 * as reset-aware / reset-window), saturation is fetched once per unique
 * connection with bounded concurrency, and the resulting order puts the freest
 * connection first. Fail-open throughout: getSaturation already returns 0 on
 * error (full headroom), and any unexpected failure leaves the target order
 * unchanged. Ties preserve priority order (stable).
 */
export async function orderTargetsByHeadroom(targets, comboName, log, apiKeyAllowedConnectionIds) {
  if (targets.length <= 1) return targets;
  try {
    const {
      expandedTargets
    } = await expandTargetsByQuotaAwareConnections(targets, comboName, log, apiKeyAllowedConnectionIds);
    if (expandedTargets.length <= 1) return expandedTargets;
    const getSaturation = await resolveHeadroomSaturationFetcher();

    // Fetch saturation once per unique provider:connection (5h + weekly).
    const satByConnection = new Map();
    const connKey = target => `${target.provider}:${target.connectionId}`;
    await mapWithConcurrency(expandedTargets, HEADROOM_SATURATION_FETCH_CONCURRENCY, async target => {
      if (!target.connectionId) return;
      const key = connKey(target);
      if (satByConnection.has(key)) return;
      satByConnection.set(key, (async () => {
        const [util5h, util7d] = await Promise.all([getSaturation(target.connectionId, target.provider, {
          unit: "percent",
          window: "5h"
        }), getSaturation(target.connectionId, target.provider, {
          unit: "percent",
          window: "weekly"
        })]);
        return {
          util5h,
          util7d
        };
      })());
      await satByConnection.get(key);
    });

    // Resolve the per-connection saturation, keyed by the per-target executionKey
    // for the pure ranker. Targets without a connection get full headroom.
    const satByExecutionKey = new Map();
    for (const target of expandedTargets) {
      if (!target.connectionId) continue;
      const sat = await satByConnection.get(connKey(target));
      if (sat) satByExecutionKey.set(target.executionKey, sat);
    }
    return rankByHeadroom(expandedTargets, satByExecutionKey, target => target.executionKey);
  } catch (err) {
    log.warn?.({
      err: err?.message,
      comboName
    }, "headroom ordering failed — keeping target order");
    return targets;
  }
}