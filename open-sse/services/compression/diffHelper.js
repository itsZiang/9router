import { extractPreservedBlocks } from "./preservation";
import { validateCompression } from "./validation";
import { scoreToken } from "./ultraHeuristic";
export const DEFAULT_MAX_PREVIEW_DIFF_TOKEN_PRODUCT = 1_000_000;
function tokenize(text) {
  return text.match(/\s+|[^\s]+/g) ?? [];
}
function getDiffSkipWarning(original, compressed, options = {}) {
  const maxTokenProduct = options.maxTokenProduct ?? DEFAULT_MAX_PREVIEW_DIFF_TOKEN_PRODUCT;
  if (maxTokenProduct <= 0) return null;
  const originalTokens = tokenize(original).length;
  const compressedTokens = tokenize(compressed).length;
  if (originalTokens * compressedTokens <= maxTokenProduct) return null;
  return `Preview diff omitted because token product ${originalTokens}x${compressedTokens} exceeds safe limit ${maxTokenProduct}.`;
}
export function buildCompressionDiff(original, compressed) {
  const a = tokenize(original);
  const b = tokenize(compressed);
  const dp = Array.from({
    length: a.length + 1
  }, () => Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const segments = [];
  const push = (type, text) => {
    if (!text) return;
    const last = segments[segments.length - 1];
    if (last?.type === type) {
      last.text += text;
    } else {
      segments.push({
        type,
        text
      });
    }
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push("same", a[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push("removed", a[i]);
      i++;
    } else {
      push("added", b[j]);
      j++;
    }
  }
  while (i < a.length) push("removed", a[i++]);
  while (j < b.length) push("added", b[j++]);
  return segments;
}

/**
 * Walk original-side diff segments (same + removed; skip added) to build a
 * Set of token indices that survived into the compressed output.
 */
function keptIndicesFromSegments(segments) {
  const keptSet = new Set();
  let cursor = 0;
  for (const seg of segments) {
    if (seg.type === "added") continue;
    const segLen = tokenize(seg.text).length;
    if (seg.type === "same") {
      for (let k = 0; k < segLen; k++) keptSet.add(cursor + k);
    }
    cursor += segLen;
  }
  return keptSet;
}

/**
 * Walk original-side diff segments to build [lo, hi] index ranges for removed spans.
 */
function removedRangesFromSegments(segments) {
  const ranges = [];
  let cursor = 0;
  for (const seg of segments) {
    if (seg.type === "added") continue;
    const segLen = tokenize(seg.text).length;
    if (seg.type === "removed") ranges.push([cursor, cursor + segLen - 1]);
    cursor += segLen;
  }
  return ranges;
}

/**
 * Build a per-token saliency heatmap for the original text.
 *
 * ultra: score each token using scoreToken (0–1); kept = token not in a removed-only diff segment.
 * universal: score is binary (1 = kept, 0 = removed); kept derived from diff segments.
 */
function buildHeatmap(mode, original, segments) {
  const rawTokens = tokenize(original);
  if (mode === "universal") {
    const keptSet = keptIndicesFromSegments(segments);
    return {
      mode,
      tokens: rawTokens.map((text, idx) => {
        const kept = keptSet.has(idx);
        return {
          text,
          score: kept ? 1 : 0,
          kept
        };
      })
    };
  }

  // ultra mode: use scoreToken; kept = not in a purely removed segment position
  const removedRanges = removedRangesFromSegments(segments);
  return {
    mode,
    tokens: rawTokens.map((text, idx) => {
      const removed = removedRanges.some(([lo, hi]) => idx >= lo && idx <= hi);
      return {
        text,
        score: scoreToken(text),
        kept: !removed
      };
    })
  };
}
export function buildCompressionPreviewDiff(original, compressed, stats, options = {}, heatmapMode) {
  const validation = validateCompression(original, compressed);
  const preserved = extractPreservedBlocks(original).blocks.map(block => ({
    kind: block.kind,
    preview: block.content.replace(/\s+/g, " ").slice(0, 120)
  }));
  const diffSkipWarning = getDiffSkipWarning(original, compressed, options);
  const segments = diffSkipWarning ? [{
    type: "same",
    text: "[diff omitted: input too large]"
  }] : buildCompressionDiff(original, compressed);
  const result = {
    segments,
    preservedBlocks: preserved,
    ruleRemovals: stats?.rulesApplied ?? [],
    validationWarnings: [...(stats?.validationWarnings ?? []), ...validation.warnings, ...(diffSkipWarning ? [diffSkipWarning] : [])],
    validationErrors: [...(stats?.validationErrors ?? []), ...validation.errors],
    fallbackApplied: Boolean(stats?.fallbackApplied || validation.fallbackApplied)
  };
  if (heatmapMode) {
    result.heatmap = buildHeatmap(heatmapMode, original, segments);
  }
  return result;
}