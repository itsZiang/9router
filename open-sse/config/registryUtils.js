/**
 * Shared Registry Utilities
 *
 * Common interfaces and helpers used by all provider registries
 * (audio, image, video, music). Extracts duplicated patterns into
 * reusable functions.
 */

/**
 * Per-registry ``modelId → providerId`` index for the bare-model lookup below.
 * The media registries (image/video/audio/music) are static module-level objects, so the
 * index is built once per registry and reused. First-wins insertion preserves the original
 * Object.entries() iteration order (the same provider the linear scan would have returned).
 */
const registryModelIndexCache = new WeakMap();
function getRegistryModelIndex(registry) {
  let index = registryModelIndexCache.get(registry);
  if (!index) {
    index = new Map();
    for (const [providerId, config] of Object.entries(registry)) {
      for (const model of config.models) {
        if (!index.has(model.id)) index.set(model.id, providerId);
      }
    }
    registryModelIndexCache.set(registry, index);
  }
  return index;
}

/**
 * Parse a "provider/model" string against a registry.
 * Supports both "provider/model" prefix and bare "model" lookup.
 */
export function parseModelFromRegistry(modelStr, registry) {
  if (!modelStr) return {
    provider: null,
    model: null
  };

  // Try each provider prefix
  for (const [providerId, config] of Object.entries(registry)) {
    if (modelStr.startsWith(providerId + "/")) {
      return {
        provider: providerId,
        model: modelStr.slice(providerId.length + 1)
      };
    }
    if (config.alias && modelStr.startsWith(config.alias + "/")) {
      return {
        provider: providerId,
        model: modelStr.slice(config.alias.length + 1)
      };
    }
  }

  // No provider prefix — find the model via the precomputed index (was an O(providers × models)
  // scan on every call).
  const providerId = getRegistryModelIndex(registry).get(modelStr);
  if (providerId) {
    return {
      provider: providerId,
      model: modelStr
    };
  }
  return {
    provider: null,
    model: modelStr
  };
}

/**
 * Flatten all models from a registry into a list with provider info.
 * Optionally merge extra fields per provider via the `extra` callback.
 */
export function getAllModelsFromRegistry(registry, extra) {
  const models = [];
  for (const [providerId, config] of Object.entries(registry)) {
    const extraFields = extra ? extra(providerId, config) : {};
    for (const model of config.models) {
      const entries = [providerId, config.alias].filter(prefix => typeof prefix === "string" && prefix.length > 0);
      for (const prefix of entries) {
        models.push({
          id: `${prefix}/${model.id}`,
          name: model.name,
          provider: providerId,
          ...extraFields
        });
      }
    }
  }
  return models;
}

/**
 * Build auth headers for a provider.
 * Handles bearer, key, token, xi-api-key, x-api-key, and none.
 */
export function buildAuthHeaders(provider, token) {
  if (provider.authType === "none" || provider.authHeader === "none" || !token) {
    return {};
  }
  switch (provider.authHeader) {
    case "key":
      return {
        Authorization: `Key ${token}`
      };
    case "token":
      return {
        Authorization: `Token ${token}`
      };
    case "xi-api-key":
      return {
        "xi-api-key": token
      };
    case "x-api-key":
      return {
        "x-api-key": token
      };
    case "bearer":
    default:
      return {
        Authorization: `Bearer ${token}`
      };
  }
}