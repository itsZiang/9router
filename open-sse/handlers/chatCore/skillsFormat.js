/**
 * chatCore skills-format mappers (Quality Gate v2 / Fase 9 — chatCore god-file decomposition, #3501).
 *
 * Pure mappers extracted from chatCore: translate the request wire format into the skills provider
 * bucket and the skills model id used when injecting skill context. Side-effect-free; behaviour is
 * byte-identical to the previous module-level functions.
 */

import { FORMATS } from "../../translator/formats";
export function getSkillsProviderForFormat(format) {
  switch (format) {
    case FORMATS.CLAUDE:
      return "anthropic";
    case FORMATS.GEMINI:
      return "google";
    default:
      return "openai";
  }
}
export function getSkillsModelIdForFormat(format) {
  switch (format) {
    case FORMATS.CLAUDE:
      return "claude";
    case FORMATS.GEMINI:
      return "gemini";
    default:
      return "openai";
  }
}