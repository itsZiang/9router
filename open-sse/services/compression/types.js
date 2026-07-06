/**
 * Compression Pipeline Types — Lite, Caveman, Aggressive, Ultra, RTK, and Stacked modes.
 *
 * Shared type definitions for the compression pipeline.
 * Phase 1: 'off' and 'lite' modes.
 * Phase 2: 'standard' mode (caveman engine).
 * Phase 3: 'aggressive' mode (summarization + tool compression + aging).
 * Phase 4: 'ultra' mode (heuristic token pruning + optional SLM tier).
 * Phase 5: 'rtk' and 'stacked' modes (tool-output filters + multi-engine pipeline).
 */

import { ENGINE_IDS } from "./engineCatalog";
// Re-export so consumers that already import from this module (e.g. src/lib/db/compression.ts)
// can get ENGINE_IDS without a second bare `@omniroute/open-sse/...engineCatalog.ts` specifier.
// That bare alias resolves under tsc/tsx but NOT under vitest (Vite externalizes a brand-new
// open-sse module to Node, which then can't load the `.ts` subpath), whereas this module is
// already in Vite's graph and its relative `./engineCatalog.ts` import resolves in-pipeline.
export { ENGINE_IDS };

/**
 * Provider-delegated compression (Anthropic "Context Editing", beta
 * `context-management-2025-06-27`). Claude/Anthropic only — the provider clears
 * old tool-use blocks server-side. This config only carries the on/off flag; the
 * request-time header/body injection is a separate slice.
 */

/** T05/C5 — system-prompt preservation intent (see `CompressionConfig.preserveSystemPromptMode`). */

export const DEFAULT_COMPRESSION_CONFIG = {
  enabled: false,
  defaultMode: "off",
  autoTriggerMode: "lite",
  autoTriggerTokens: 0,
  cacheMinutes: 5,
  preserveSystemPrompt: true,
  preserveSystemPromptMode: "always",
  mcpDescriptionCompressionEnabled: true,
  comboOverrides: {},
  compressionComboId: null,
  stackedPipeline: [{
    engine: "rtk",
    intensity: "standard"
  }, {
    engine: "caveman",
    intensity: "full"
  }],
  engines: Object.fromEntries(ENGINE_IDS.map(id => [id, {
    enabled: false
  }])),
  activeComboId: null,
  ultraEngine: "heuristic",
  ultraSlmPrewarm: false
};
export const DEFAULT_CAVEMAN_CONFIG = {
  enabled: false,
  compressRoles: ["user"],
  skipRules: [],
  minMessageLength: 50,
  // Protect code blocks, inline code, file paths, URLs, and error/stack lines
  // from caveman compression so signal-carrying content is never mangled.
  preservePatterns: ["```[\\s\\S]*?```", "`[^`\\n]+`", "\\b(https?://\\S+)", "(?:^|\\s)(\\.{0,2}/[\\w./\\-]+)", "^\\s*(Error|TypeError|RangeError|SyntaxError|ReferenceError):", "^\\s+at\\s"],
  intensity: "lite"
};
export const DEFAULT_CAVEMAN_OUTPUT_MODE_CONFIG = {
  enabled: false,
  intensity: "lite",
  autoClarity: true
};
export const DEFAULT_RTK_CONFIG = {
  enabled: false,
  intensity: "minimal",
  applyToToolResults: true,
  applyToCodeBlocks: false,
  applyToAssistantMessages: false,
  enabledFilters: [],
  disabledFilters: [],
  maxLinesPerResult: 120,
  maxCharsPerResult: 12000,
  deduplicateThreshold: 3,
  customFiltersEnabled: true,
  trustProjectFilters: false,
  rawOutputRetention: "never",
  rawOutputMaxBytes: 1_048_576,
  enableGrouping: false,
  groupingThreshold: 3,
  stripCodeComments: false,
  preserveDocstrings: true,
  enableRenderers: false
};
export const DEFAULT_COMPRESSION_LANGUAGE_CONFIG = {
  enabled: false,
  defaultLanguage: "en",
  autoDetect: true,
  enabledPacks: ["en"]
};
export const DEFAULT_CONTEXT_EDITING_CONFIG = {
  enabled: false
};

/** Aging thresholds for progressive message degradation (Phase 3) */

/** Tool result compression strategy toggles (Phase 3) */

/** Configuration for aggressive compression mode (Phase 3) */

/** Options for the Summarizer interface (Phase 3) */

/** Summarizer interface — rule-based default, LLM-ready for future drop-in (Phase 3) */

/** Default aggressive configuration (Phase 3) */
export const DEFAULT_AGGRESSIVE_CONFIG = {
  thresholds: {
    fullSummary: 5,
    moderate: 3,
    light: 2,
    verbatim: 2
  },
  toolStrategies: {
    fileContent: true,
    grepSearch: true,
    shellOutput: true,
    json: true,
    errorMessage: true
  },
  summarizerEnabled: true,
  maxTokensPerMessage: 2048,
  minSavingsThreshold: 0.05
};

// ─── Phase 4: Ultra Compression ──────────────────────────────────────────────

export const DEFAULT_ULTRA_CONFIG = {
  enabled: false,
  compressionRate: 0.5,
  minScoreThreshold: 0.3,
  slmFallbackToAggressive: true,
  maxTokensPerMessage: 0
};
export { DEFAULT_MCP_ACCESSIBILITY_CONFIG, clampMcpAccessibilityConfig } from "./engines/mcpAccessibility/constants";