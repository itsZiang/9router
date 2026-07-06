import { applyRulesToText } from "../services/compression/caveman";
import { getRulesForContext } from "../services/compression/cavemanRules";
import { extractPreservedBlocks, restorePreservedBlocks } from "../services/compression/preservation";
const descriptionCompressionStats = {
  descriptionsCompressed: 0,
  charsBefore: 0,
  charsAfter: 0,
  charsSaved: 0,
  estimatedTokensSaved: 0
};
const persistedDescriptionCompressionStats = {
  descriptionsCompressed: 0,
  charsBefore: 0,
  charsAfter: 0,
  charsSaved: 0,
  estimatedTokensSaved: 0
};
const MCP_LIST_CONTAINER_KEYS = new Set(["tools", "prompts", "resources", "resourceTemplates"]);
const MCP_METADATA_DESCRIPTION_FIELDS = ["description"];
function isDisabledEnvValue(value) {
  return !!value && ["0", "false", "off", "no"].includes(value.trim().toLowerCase());
}
export function isMcpDescriptionCompressionEnabled(options = {}) {
  if (isDisabledEnvValue(process.env.OMNIROUTE_MCP_COMPRESS_DESCRIPTIONS)) return false;
  if (isDisabledEnvValue(process.env.OMNIROUTE_MCP_DESCRIPTION_COMPRESSION)) return false;
  return options.enabled !== false;
}
export function compressMcpDescription(description) {
  if (!description) {
    return {
      compressed: description,
      before: 0,
      after: 0,
      changed: false
    };
  }
  const {
    text,
    blocks
  } = extractPreservedBlocks(description);
  const rules = getRulesForContext("all", "full");
  const applied = applyRulesToText(text, rules).text;
  const normalized = applied.replace(/[ \t]{2,}/g, " ").replace(/[ \t]([,.;:!?])/g, "$1").replace(/\n{3,}/g, "\n\n").replace(/(^|[.!?][ \t]|\n[ \t]*)([a-z])/g, (_match, prefix, char) => {
    return `${prefix}${char.toUpperCase()}`;
  }).trim();
  const compressed = restorePreservedBlocks(normalized, blocks);
  return {
    compressed,
    before: description.length,
    after: compressed.length,
    changed: compressed !== description
  };
}
export function maybeCompressMcpDescription(description, options = {}) {
  if (!isMcpDescriptionCompressionEnabled(options)) return description;
  const result = compressMcpDescription(description);
  if (result.changed && result.after < result.before) {
    descriptionCompressionStats.descriptionsCompressed += 1;
    descriptionCompressionStats.charsBefore += result.before;
    descriptionCompressionStats.charsAfter += result.after;
    descriptionCompressionStats.charsSaved += result.before - result.after;
    descriptionCompressionStats.estimatedTokensSaved += Math.ceil((result.before - result.after) / 4);
    return result.compressed;
  }
  return description;
}
export function compressDescriptionsInPlace(value, fieldNames = ["description"], options = {}) {
  if (!value || typeof value !== "object") return;
  const fields = new Set(fieldNames);
  if (Array.isArray(value)) {
    for (const item of value) compressDescriptionsInPlace(item, fieldNames, options);
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (fields.has(key) && typeof nested === "string") {
      value[key] = maybeCompressMcpDescription(nested, options);
    } else if (nested && typeof nested === "object") {
      compressDescriptionsInPlace(nested, fieldNames, options);
    }
  }
}
function clonePlainMetadata(value) {
  if (!value || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value));
}
function compressMcpListContainersInPlace(value, options = {}) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) compressMcpListContainersInPlace(item, options);
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (MCP_LIST_CONTAINER_KEYS.has(key) && Array.isArray(nested)) {
      compressDescriptionsInPlace(nested, MCP_METADATA_DESCRIPTION_FIELDS, options);
    } else if (nested && typeof nested === "object") {
      compressMcpListContainersInPlace(nested, options);
    }
  }
}
export function compressMcpListMetadata(value, options = {}) {
  if (!isMcpDescriptionCompressionEnabled(options)) return value;
  const clone = clonePlainMetadata(value);
  compressMcpListContainersInPlace(clone, options);
  return clone;
}
export function compressMcpRegistryMetadata(metadata, options = {}) {
  if (!isMcpDescriptionCompressionEnabled(options)) return metadata;
  const clone = {
    ...metadata
  };
  if (typeof clone.description === "string") {
    clone.description = maybeCompressMcpDescription(clone.description, options);
  }
  return clone;
}
export function getMcpDescriptionCompressionStats() {
  return {
    ...descriptionCompressionStats
  };
}
function getUnpersistedMcpDescriptionCompressionStats() {
  return {
    descriptionsCompressed: descriptionCompressionStats.descriptionsCompressed - persistedDescriptionCompressionStats.descriptionsCompressed,
    charsBefore: descriptionCompressionStats.charsBefore - persistedDescriptionCompressionStats.charsBefore,
    charsAfter: descriptionCompressionStats.charsAfter - persistedDescriptionCompressionStats.charsAfter,
    charsSaved: descriptionCompressionStats.charsSaved - persistedDescriptionCompressionStats.charsSaved,
    estimatedTokensSaved: descriptionCompressionStats.estimatedTokensSaved - persistedDescriptionCompressionStats.estimatedTokensSaved
  };
}
export async function snapshotMcpDescriptionCompressionStats() {
  const delta = getUnpersistedMcpDescriptionCompressionStats();
  if (delta.descriptionsCompressed <= 0 || delta.charsSaved <= 0 || delta.estimatedTokensSaved <= 0) {
    return {
      descriptionsCompressed: 0,
      charsBefore: 0,
      charsAfter: 0,
      charsSaved: 0,
      estimatedTokensSaved: 0
    };
  }
  const originalTokens = Math.max(delta.estimatedTokensSaved, Math.ceil(delta.charsBefore / 4));
  const compressedTokens = Math.max(0, originalTokens - delta.estimatedTokensSaved);
  const {
    insertCompressionAnalyticsRow
  } = await import("../stubs/lib/db/compressionAnalytics");
  insertCompressionAnalyticsRow({
    timestamp: new Date().toISOString(),
    mode: "mcp-description",
    engine: "mcp-description",
    original_tokens: originalTokens,
    compressed_tokens: compressedTokens,
    tokens_saved: delta.estimatedTokensSaved,
    mcp_description_tokens_saved: delta.estimatedTokensSaved
  });
  persistedDescriptionCompressionStats.descriptionsCompressed = descriptionCompressionStats.descriptionsCompressed;
  persistedDescriptionCompressionStats.charsBefore = descriptionCompressionStats.charsBefore;
  persistedDescriptionCompressionStats.charsAfter = descriptionCompressionStats.charsAfter;
  persistedDescriptionCompressionStats.charsSaved = descriptionCompressionStats.charsSaved;
  persistedDescriptionCompressionStats.estimatedTokensSaved = descriptionCompressionStats.estimatedTokensSaved;
  return delta;
}
export function resetMcpDescriptionCompressionStats() {
  descriptionCompressionStats.descriptionsCompressed = 0;
  descriptionCompressionStats.charsBefore = 0;
  descriptionCompressionStats.charsAfter = 0;
  descriptionCompressionStats.charsSaved = 0;
  descriptionCompressionStats.estimatedTokensSaved = 0;
  persistedDescriptionCompressionStats.descriptionsCompressed = 0;
  persistedDescriptionCompressionStats.charsBefore = 0;
  persistedDescriptionCompressionStats.charsAfter = 0;
  persistedDescriptionCompressionStats.charsSaved = 0;
  persistedDescriptionCompressionStats.estimatedTokensSaved = 0;
}