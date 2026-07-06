/**
 * getAllToolDefinitions — unified catalog of all MCP tool definitions.
 *
 * Aggregates the same collections referenced by TOTAL_MCP_TOOL_COUNT in server.ts:
 *   MCP_TOOLS + memoryTools + skillTools + agentSkillTools + poolTools +
 *   gamificationTools + pluginTools + notionTools + obsidianTools
 *
 * Tolerates both Array and Record shapes. Deduplicates by name (first wins).
 */

import { MCP_TOOLS } from "../schemas/tools";
import { memoryTools } from "../tools/memoryTools";
import { skillTools } from "../tools/skillTools";
import { agentSkillTools } from "../tools/agentSkillTools";
import { poolTools } from "../tools/poolTools";
import { gamificationTools } from "../tools/gamificationTools";
import { pluginTools } from "../tools/pluginTools";
import { notionTools } from "../tools/notionTools";
import { obsidianTools } from "../tools/obsidianTools";
import { compressionTools } from "../tools/compressionTools";
function normalizeEntry(raw) {
  const name = typeof raw.name === "string" ? raw.name : null;
  const description = typeof raw.description === "string" ? raw.description : "";
  if (!name) return null;
  const scopes = Array.isArray(raw.scopes) ? raw.scopes.filter(s => typeof s === "string") : [];
  return {
    name,
    description,
    scopes,
    inputSchema: raw.inputSchema
  };
}
function collectFromArray(arr) {
  const result = [];
  for (const item of arr) {
    const entry = normalizeEntry(item);
    if (entry) result.push(entry);
  }
  return result;
}
function collectFromRecord(rec) {
  return collectFromArray(Object.values(rec));
}
function collectAny(collection) {
  if (Array.isArray(collection)) return collectFromArray(collection);
  if (collection && typeof collection === "object") {
    return collectFromRecord(collection);
  }
  return [];
}

/**
 * Returns a deduplicated list of all registered MCP tool catalog entries.
 * Deduplication: first occurrence by name wins.
 */
export function getAllToolDefinitions() {
  const collections = [MCP_TOOLS, memoryTools, skillTools, agentSkillTools, poolTools, gamificationTools, pluginTools, notionTools, obsidianTools,
  // compressionTools holds omniroute_ccr_retrieve, which is NOT in MCP_TOOLS — without it
  // a `tool_search("compression")` would miss that tool. The other 5 overlap MCP_TOOLS and
  // are resolved by the dedup-by-name below (first wins).
  compressionTools];
  const seen = new Set();
  const result = [];
  for (const collection of collections) {
    for (const entry of collectAny(collection)) {
      if (!seen.has(entry.name)) {
        seen.add(entry.name);
        result.push(entry);
      }
    }
  }
  return result;
}