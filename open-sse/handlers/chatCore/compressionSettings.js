/**
 * chatCore compression settings resolution (Quality Gate v2 / Fase 9 — chatCore god-file
 * decomposition, #3501).
 *
 * Extracted from handleChatCore's Proactive Context Compression setup: read the canonical
 * compression settings and derive the prompt-compression and delegated context-editing flags.
 * Best-effort — on a lookup error it logs and falls back to disabled, exactly like the previous
 * inline try/catch. Behaviour is byte-identical.
 */

export async function resolveCompressionSettings(log) {
  try {
    const {
      getCompressionSettings
    } = await import("../../stubs/lib/db/compression");
    const settings = await getCompressionSettings();
    return {
      settings,
      enabled: settings.enabled,
      contextEditingEnabled: settings.contextEditing?.enabled === true
    };
  } catch (err) {
    log?.warn?.("COMPRESSION", "Compression settings lookup skipped: " + (err instanceof Error ? err.message : String(err)));
    return {
      settings: null,
      enabled: false,
      contextEditingEnabled: false
    };
  }
}