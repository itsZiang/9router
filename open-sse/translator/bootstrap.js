/**
 * Explicit translator bootstrap module.
 * Importing this file initializes all translator adapters via side-effect registration.
 */

import "./request/claude-to-openai";
import "./request/openai-to-claude";
import "./request/gemini-to-openai";
import "./request/openai-to-gemini";
import "./request/antigravity-to-openai";
import "./request/openai-responses";
import "./request/openai-to-kiro";
import "./request/openai-to-cursor";
import "./request/claude-to-gemini";
import "./response/claude-to-openai";
import "./response/openai-to-claude";
import "./response/gemini-to-openai";
import "./response/gemini-to-claude";
import "./response/openai-to-antigravity";
import "./response/openai-responses";
import "./response/kiro-to-openai";
import "./response/cursor-to-openai";
export function bootstrapTranslatorRegistry() {
  // no-op by design; importing this module triggers translator self-registration once
}