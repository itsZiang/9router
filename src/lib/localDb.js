// Shim → re-export from new SQLite-based DB layer (src/lib/db/)
// Kept for backward compatibility with existing imports.
export {
  getSettings, updateSettings, isCloudEnabled, getCloudUrl,
  getProviderConnections, getProviderConnectionById,
  createProviderConnection, updateProviderConnection, batchCreatePoolConnections, moveConnectionsToPool,
  deleteProviderConnection, deleteProviderConnectionsByProvider,
  reorderProviderConnections, cleanupProviderConnections,
  getProviderNodes, getProviderNodeById,
  createProviderNode, updateProviderNode, deleteProviderNode,
  getProxyPools, getProxyPoolById,
  createProxyPool, updateProxyPool, deleteProxyPool,
  getApiKeys, getApiKeyById, createApiKey, updateApiKey, deleteApiKey, validateApiKey,
  getCombos, getComboById, getComboByName,
  createCombo, updateCombo, deleteCombo, reorderCombos,
  getModelAliases, setModelAlias, deleteModelAlias,
  getCustomModels, addCustomModel, deleteCustomModel,
  getMitmAlias, setMitmAliasAll,
  getPricing, getPricingForModel, updatePricing, resetPricing, resetAllPricing,
  addKeysToPool, getPoolKeys, getPoolKeysPaged, getPoolCount, removeKeyFromPool, pullKeysFromPool,
  getPoolSize, setPoolSize, getAutoReplace, setAutoReplace,
  getModelOrder, setModelOrder,
  exportDb, importDb,
} from "@/lib/db/index.js";

export function getModelNormalizeToolCallId(providerId, modelId, sourceFormat) {
  return false;
}

export function getModelPreserveOpenAIDeveloperRole(providerId, modelId, sourceFormat) {
  return undefined;
}

export async function incrementWindowTokens(id, windowStart, delta) {
  return typeof delta === "number" ? delta : 0;
}

export async function getWindowUsage(id, windowStart) {
  return 0;
}

export async function resetWindowIfElapsed(limit, now) {
  return { windowStart: now, needsReset: false };
}

export async function getTokenLimitsForRequest(options) {
  return [];
}

export async function logTokenLimitReset(entryId) {
  return;
}

export async function resolveProxyForScopeFromRegistry(scope) {
  return null;
}

export async function listProxies(options = {}) {
  return [];
}

export async function listOneproxyProxies(options = {}) {
  return [];
}

export async function getUpstreamProxyConfig(provider) {
  return null;
}
