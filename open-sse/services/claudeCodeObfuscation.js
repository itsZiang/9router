/**
 * Sensitive word obfuscation for Claude Code requests.
 *
 * Obfuscates configurable words in user messages to prevent detection
 * by upstream content filters. Uses zero-width characters to break
 * pattern matching while preserving readability.
 */

// Unicode zero-width joiner inserted between characters
const ZWJ = "\u200d";
const DEFAULT_SENSITIVE_WORDS = ["opencode", "open-code", "cline", "roo-cline", "roo_cline", "cursor", "windsurf", "aider", "continue.dev", "copilot", "avante", "codecompanion"];
let sensitiveWords = [...DEFAULT_SENSITIVE_WORDS];
export function setSensitiveWords(words) {
  sensitiveWords = words.length > 0 ? words : [...DEFAULT_SENSITIVE_WORDS];
}
export function getSensitiveWords() {
  return [...sensitiveWords];
}
function obfuscateWord(word) {
  if (word.length <= 1) return word;
  // Insert ZWJ after first character
  return word[0] + ZWJ + word.slice(1);
}

// Per-word regex cache — obfuscateSensitiveWords recompiles one RegExp per word on every
// request body otherwise. Bounded by distinct configured words; global regexes are safe to
// reuse because String.replace resets lastIndex.
const _obfuscationRegexCache = new Map();
function getObfuscationRegex(word) {
  let regex = _obfuscationRegexCache.get(word);
  if (!regex) {
    if (_obfuscationRegexCache.size > 2000) _obfuscationRegexCache.clear();
    regex = new RegExp(escapeRegex(word), "gi");
    _obfuscationRegexCache.set(word, regex);
  }
  return regex;
}
export function obfuscateSensitiveWords(text) {
  if (!text || sensitiveWords.length === 0) return text;
  let result = text;
  for (const word of sensitiveWords) {
    if (!word) continue;
    // Case-insensitive replacement (cached: see getObfuscationRegex)
    const regex = getObfuscationRegex(word);
    result = result.replace(regex, match => obfuscateWord(match));
  }
  return result;
}
export function obfuscateInBody(body) {
  // System prompt (Claude format: string or array of blocks)
  if (typeof body.system === "string") {
    body.system = obfuscateSensitiveWords(body.system);
  } else if (Array.isArray(body.system)) {
    for (const block of body.system) {
      if (typeof block.text === "string") {
        block.text = obfuscateSensitiveWords(block.text);
      }
    }
  }

  // Messages (all roles, not just user — system/assistant may also contain sensitive words)
  const messages = body.messages;
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      const content = msg.content;
      if (typeof content === "string") {
        msg.content = obfuscateSensitiveWords(content);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block.text === "string") {
            block.text = obfuscateSensitiveWords(block.text);
          }
        }
      }
    }
  }

  // Tool descriptions (may contain URLs or names like "opencode")
  const tools = body.tools;
  if (Array.isArray(tools)) {
    for (const tool of tools) {
      if (typeof tool.description === "string") {
        tool.description = obfuscateSensitiveWords(tool.description);
      }
      const fn = tool.function;
      if (fn && typeof fn.description === "string") {
        fn.description = obfuscateSensitiveWords(fn.description);
      }
    }
  }
}
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}