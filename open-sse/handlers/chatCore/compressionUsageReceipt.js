/**
 * chatCore compression-usage receipt attachment (Quality Gate v2 / Fase 9 — chatCore god-file
 * decomposition, #3501).
 *
 * Extracted from handleChatCore: best-effort, fire-and-forget attachment of a usage receipt to the
 * stored compression-analytics row, ordered after any in-flight analytics write (`pendingWrite`) so
 * the receipt lands on the persisted row. Errors are swallowed — analytics must never affect the
 * response. The per-request inputs are passed via `ctx`; behaviour is byte-identical to the previous
 * inline closure.
 */

export function attachCompressionUsageReceiptAfterAnalytics(usage, source, ctx) {
  const {
    pendingWrite,
    skillRequestId
  } = ctx;
  void (async () => {
    try {
      if (pendingWrite) await pendingWrite;
      const {
        attachCompressionUsageReceipt
      } = await import("../../stubs/lib/db/compressionAnalytics");
      attachCompressionUsageReceipt(skillRequestId, usage, source);
    } catch {
      // Compression analytics are best-effort and must never affect responses.
    }
  })();
}