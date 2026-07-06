/**
 * chatCore compression analytics write (Quality Gate v2 / Fase 9 — chatCore god-file
 * decomposition, #3501).
 *
 * Extracted from handleChatCore's request-setup compression path: persist the per-run compression
 * analytics row (cost saved, RTK raw-output pointers) plus the per-engine breakdown of a stacked
 * run. Returns the write promise (the caller assigns it to compressionAnalyticsWritePromise) and
 * swallows its own errors — best-effort, off the hot path, never throws into a request. Behaviour
 * is byte-identical to the previous inline block. Split into small builders so each stays under the
 * complexity cap.
 */

function buildRtkPointerFields(rtkPointers) {
  return {
    rtk_raw_output_pointer: rtkPointers[0]?.id ?? null,
    rtk_raw_output_bytes: rtkPointers[0]?.bytes ?? null,
    rtk_raw_output_pointers: rtkPointers.length ? JSON.stringify(rtkPointers.map(pointer => pointer.id)) : null,
    rtk_raw_output_total_bytes: rtkPointers.length ? rtkPointers.reduce((total, pointer) => total + (pointer.bytes ?? 0), 0) : null
  };
}
function buildAnalyticsRow(opts, tokensSaved, rtkPointers, estimatedUsdSaved) {
  const {
    stats
  } = opts;
  return {
    timestamp: new Date().toISOString(),
    combo_id: opts.comboName ?? null,
    provider: opts.provider ?? null,
    mode: opts.mode,
    engine: stats.engine ?? opts.mode,
    compression_combo_id: stats.compressionComboId ?? opts.compressionComboId ?? null,
    original_tokens: stats.originalTokens,
    compressed_tokens: stats.compressedTokens,
    tokens_saved: tokensSaved,
    duration_ms: stats.durationMs ?? null,
    request_id: opts.skillRequestId,
    estimated_usd_saved: estimatedUsdSaved || null,
    validation_fallback: stats.fallbackApplied ? 1 : 0,
    output_mode: opts.cavemanOutputModeApplied ? opts.cavemanOutputModeIntensity : null,
    ...buildRtkPointerFields(rtkPointers)
  };
}
function buildEngineBreakdownRows(stats, requestId) {
  const engineBreakdown = stats.engineBreakdown ?? [];
  return engineBreakdown.map(b => ({
    timestamp: new Date().toISOString(),
    request_id: requestId,
    engine: b.engine,
    original_tokens: b.originalTokens,
    compressed_tokens: b.compressedTokens,
    tokens_saved: Math.max(0, b.originalTokens - b.compressedTokens),
    duration_ms: b.durationMs ?? null
  }));
}

/**
 * Record an attempted-but-no-op compression run (#4268). The pipeline ran (mode
 * active, engines executed) but produced no recordable saving — without this, the
 * row is dropped and "ran but saved nothing" is indistinguishable from "never ran".
 * Writes a single skip row (tokens_saved = 0, skip_reason set); no engine breakdown,
 * to keep skips out of the saving aggregates.
 */
export function writeCompressionSkip(opts, skipReason) {
  return (async () => {
    try {
      const {
        insertCompressionAnalyticsRow
      } = await import("../../stubs/lib/db/compressionAnalytics");
      const {
        stats
      } = opts;
      insertCompressionAnalyticsRow({
        timestamp: new Date().toISOString(),
        combo_id: opts.comboName ?? null,
        provider: opts.provider ?? null,
        mode: opts.mode,
        engine: stats.engine ?? opts.mode,
        compression_combo_id: stats.compressionComboId ?? opts.compressionComboId ?? null,
        original_tokens: stats.originalTokens,
        compressed_tokens: stats.compressedTokens,
        tokens_saved: 0,
        duration_ms: stats.durationMs ?? null,
        request_id: opts.skillRequestId,
        skip_reason: skipReason
      });
    } catch (err) {
      opts.log?.debug?.("COMPRESSION", "Compression skip-analytics write skipped: " + (err instanceof Error ? err.message : String(err)));
    }
  })();
}
export function writeCompressionAnalytics(opts) {
  return (async () => {
    try {
      const {
        insertCompressionAnalyticsRow,
        insertCompressionEngineBreakdown
      } = await import("../../stubs/lib/db/compressionAnalytics");
      const {
        calculateCost
      } = await import("../../stubs/lib/usage/costCalculator");
      const {
        stats
      } = opts;
      const tokensSaved = Math.max(0, stats.originalTokens - stats.compressedTokens);
      const rtkPointers = stats.rtkRawOutputPointers ?? [];
      const estimatedUsdSaved = await calculateCost(opts.provider ?? "", opts.effectiveModel ?? "", {
        input: tokensSaved
      }, {
        serviceTier: opts.effectiveServiceTier
      });
      insertCompressionAnalyticsRow(buildAnalyticsRow(opts, tokensSaved, rtkPointers, estimatedUsdSaved));
      const breakdownRows = buildEngineBreakdownRows(stats, opts.skillRequestId);
      if (breakdownRows.length > 0) {
        insertCompressionEngineBreakdown(breakdownRows);
      }
    } catch (err) {
      opts.log?.debug?.("COMPRESSION", "Compression analytics write skipped: " + (err instanceof Error ? err.message : String(err)));
    }
  })();
}