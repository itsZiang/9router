/**
 * CC Bridge Transforms — config-driven request body normalization for the
 * Claude Code Compatible (`anthropic-compatible-cc-*`) bridge.
 *
 * Goal: ensure the final request body OmniRoute sends to Anthropic's
 * `/v1/messages?beta=true` endpoint has classifier-correct structure
 * regardless of which client (OpenCode, Cline, Cursor, Continue, raw API
 * consumer) supplied the prompt.
 *
 * Approach: an ordered pipeline of declarative `TransformOp` entries that
 * mutate the request body in place. Each op is idempotent; the executor is
 * pure (no I/O); new defenses can be added through Settings UI by appending
 * a new op — no new TypeScript needed.
 *
 * Reference implementation: ex-machina/opencode-anthropic-auth `transform.ts`
 * and `cch.ts`. Ported with the same defaults (paragraph anchors, identity
 * prefixes, text replacements, billing header algorithm) but generalised
 * behind a discriminated-union DSL so future fingerprints are configurable.
 *
 * Related: OmniRoute issue #2260.
 */
import { createHash } from "node:crypto";

// ────────────────────────────────────────────────────────────────────────────
// DSL types
// ────────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────
// Ported constants (ex-machina/constants.ts)
// ────────────────────────────────────────────────────────────────────────────

/** Stable salt used by ex-machina/cch.ts for the version-suffix hash. */
export const CCH_SALT = "59cf53e54c78";
/** Character positions sampled from the first user message text. */
export const CCH_POSITIONS = [4, 7, 20];
/** Default `cc_version=` value embedded in the billing header. */
export const DEFAULT_CLAUDE_CODE_VERSION = "2.1.195";
/** Identity sentinel prepended for Claude Agent SDK callers. */
export const CLAUDE_AGENT_SDK_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
/** Paragraph anchors from ex-machina (URLs identifying third-party agents). */
export const DEFAULT_PARAGRAPH_REMOVAL_ANCHORS = ["github.com/anomalyco/opencode", "opencode.ai/docs", "github.com/cline/cline", "github.com/getcursor/cursor", "continue.dev"];
/** Identity paragraph prefixes that signal a third-party agent. */
export const DEFAULT_IDENTITY_PREFIXES = ["You are OpenCode"];
/** Text replacements (last entry is the v1.7.5 phrase-shape filter fix). */
export const DEFAULT_TEXT_REPLACEMENTS = [{
  match: "if OpenCode honestly",
  replacement: "if the assistant honestly"
}, {
  match: "Here is some useful information about the environment you are running in:",
  replacement: "Environment context you are running in:"
}];

/**
 * Default pipeline shipped with the PR — matches the T4-200 fixture layout
 * proven against the live OmniRoute deployment (call log
 * f0c2fedb-b27a-4f1d-9ee6-0c88646a6d42).
 *
 * Layout after pipeline (system blocks):
 *   [0] x-anthropic-billing-header: cc_version=…; cc_entrypoint=sdk-cli; cch=…
 *   [1] You are a Claude agent, built on Anthropic's Claude Agent SDK.
 *   [2..] sanitized caller-supplied system blocks
 */
export const DEFAULT_CC_BRIDGE_PIPELINE = [
// Sanitize caller-supplied system blocks first so dropped paragraphs do not
// accidentally contain a stale billing header from a previous pass.
{
  kind: "drop_paragraph_if_contains",
  needles: [...DEFAULT_PARAGRAPH_REMOVAL_ANCHORS]
}, {
  kind: "drop_paragraph_if_starts_with",
  prefixes: [...DEFAULT_IDENTITY_PREFIXES]
}, ...DEFAULT_TEXT_REPLACEMENTS.map(r => ({
  kind: "replace_text",
  match: r.match,
  replacement: r.replacement,
  allOccurrences: true
})),
// Then prepend the SDK identity (becomes block[1] after billing prepend).
{
  kind: "prepend_system_block",
  text: CLAUDE_AGENT_SDK_IDENTITY,
  idempotencyKey: "claude-agent-sdk-identity"
},
// Billing header always lands at block[0] — matches T4-200 fixture layout.
{
  kind: "inject_billing_header",
  entrypoint: "sdk-cli",
  versionFormat: "ex-machina",
  cchAlgo: "sha256-first-user"
}];
export const DEFAULT_CC_BRIDGE_TRANSFORMS_CONFIG = {
  enabled: true,
  pipeline: DEFAULT_CC_BRIDGE_PIPELINE
};

// ────────────────────────────────────────────────────────────────────────────
// Billing header value
// ────────────────────────────────────────────────────────────────────────────

/**
 * Pull the textual content of the first user message in the request.
 * Returns "" when no user message has text content.
 */
export function extractFirstUserMessageText(messages) {
  if (!Array.isArray(messages)) return "";
  for (const msg of messages) {
    if (msg?.role !== "user") continue;
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block?.type === "text" && typeof block.text === "string") {
          return block.text;
        }
      }
    }
  }
  return "";
}
function sha256Hex(input) {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
function pickCharsAtPositions(text, positions) {
  return positions.map(p => typeof text[p] === "string" ? text[p] : "\0").join("");
}

/**
 * Compute the `cc_version` suffix per the ex-machina algorithm.
 *
 * `sha256(CCH_SALT + chars-at-CCH_POSITIONS(firstUserMessage) + version).slice(0, 3)`
 */
export function computeExMachinaVersionSuffix(firstUserText, version) {
  const picks = pickCharsAtPositions(firstUserText, CCH_POSITIONS);
  return sha256Hex(`${CCH_SALT}${picks}${version}`).slice(0, 3);
}

/**
 * Compute the `cc_version` suffix per the OmniRoute native-OAuth algorithm:
 * sha256(YYYY-MM-DD + version).slice(0,3). Stable per UTC day.
 */
export function computeDaystampVersionSuffix(version, now = new Date()) {
  const dayStamp = now.toISOString().slice(0, 10);
  return sha256Hex(`${dayStamp}${version}`).slice(0, 3);
}

/**
 * Compute the `cch=` attestation value per ex-machina algorithm:
 * sha256(firstUserMessage).slice(0,5).
 */
export function computeCchSha256FirstUser(firstUserText) {
  return sha256Hex(firstUserText).slice(0, 5);
}
/**
 * Build the `x-anthropic-billing-header: …` string injected as system block[0].
 *
 * `xxhash64-body` and `static-zero` both emit `cch=00000` here because the
 * actual body-level CCH attestation is computed later by
 * `claudeCodeCCH.signRequestBody()` and replaces a 00000 placeholder in the
 * serialized JSON. ex-machina's `sha256-first-user` value lives in the
 * header itself.
 */
export function buildBillingHeaderValue(messages, options) {
  const version = options.version || DEFAULT_CLAUDE_CODE_VERSION;
  const firstUserText = extractFirstUserMessageText(messages);
  const suffix = options.versionFormat === "omniroute-daystamp" ? computeDaystampVersionSuffix(version, options.now) : computeExMachinaVersionSuffix(firstUserText, version);
  let cch;
  switch (options.cchAlgo) {
    case "sha256-first-user":
      cch = computeCchSha256FirstUser(firstUserText);
      break;
    case "xxhash64-body":
    case "static-zero":
    default:
      cch = "00000";
      break;
  }
  return `x-anthropic-billing-header: cc_version=${version}.${suffix}; cc_entrypoint=${options.entrypoint}; cch=${cch};`;
}

// ────────────────────────────────────────────────────────────────────────────
// Body shape helpers
// ────────────────────────────────────────────────────────────────────────────

function normalizeSystemToBlocks(system) {
  if (system === null || system === undefined) return [];
  if (typeof system === "string") {
    return system.length > 0 ? [{
      type: "text",
      text: system
    }] : [];
  }
  if (Array.isArray(system)) {
    return system.filter(b => !!b && typeof b === "object").map(b => ({
      ...b
    }));
  }
  if (typeof system === "object") {
    const block = system;
    return block && typeof block.text === "string" ? [{
      ...block
    }] : [];
  }
  return [];
}
function isTextBlock(block) {
  return block.type === "text" && typeof block.text === "string";
}
function containsString(haystack, needle, caseSensitive) {
  if (caseSensitive) return haystack.includes(needle);
  return haystack.toLowerCase().includes(needle.toLowerCase());
}
function startsWithString(haystack, prefix, caseSensitive) {
  if (caseSensitive) return haystack.startsWith(prefix);
  return haystack.toLowerCase().startsWith(prefix.toLowerCase());
}

// ────────────────────────────────────────────────────────────────────────────
// Op executors
// ────────────────────────────────────────────────────────────────────────────

function applyDropParagraphIfContains(blocks, op) {
  const caseSensitive = op.caseSensitive !== false;
  const needles = op.needles || [];
  if (needles.length === 0) return blocks;
  return blocks.map(block => {
    if (!isTextBlock(block)) return block;
    const paragraphs = block.text.split(/\n\n+/);
    const filtered = paragraphs.filter(p => !needles.some(n => containsString(p, n, caseSensitive)));
    return {
      ...block,
      text: filtered.join("\n\n")
    };
  });
}
function applyDropParagraphIfStartsWith(blocks, op) {
  const caseSensitive = op.caseSensitive !== false;
  const prefixes = op.prefixes || [];
  if (prefixes.length === 0) return blocks;
  return blocks.map(block => {
    if (!isTextBlock(block)) return block;
    const paragraphs = block.text.split(/\n\n+/);
    const filtered = paragraphs.filter(p => !prefixes.some(prefix => startsWithString(p.trimStart(), prefix, caseSensitive)));
    return {
      ...block,
      text: filtered.join("\n\n")
    };
  });
}
function applyReplaceText(blocks, op) {
  if (!op.match) return blocks;
  return blocks.map(block => {
    if (!isTextBlock(block)) return block;
    if (!block.text.includes(op.match)) return block;
    let next = block.text;
    if (op.allOccurrences) {
      next = next.split(op.match).join(op.replacement);
    } else {
      next = next.replace(op.match, op.replacement);
    }
    return {
      ...block,
      text: next
    };
  });
}
function applyReplaceRegex(blocks, op) {
  if (!op.pattern) return blocks;
  let regex;
  try {
    regex = new RegExp(op.pattern, op.flags ?? "u");
  } catch {
    return blocks;
  }
  return blocks.map(block => {
    if (!isTextBlock(block)) return block;
    return {
      ...block,
      text: block.text.replace(regex, op.replacement)
    };
  });
}
function applyDropBlockIfContains(blocks, op) {
  const needles = op.needles || [];
  if (needles.length === 0) return blocks;
  return blocks.filter(block => {
    if (!isTextBlock(block)) return true;
    return !needles.some(n => block.text.includes(n));
  });
}
function applyPrependSystemBlock(blocks, op) {
  if (!op.text) return blocks;
  // Idempotency: skip if any text block already starts with idempotencyKey (when
  // set) or with op.text itself (default). Scans ALL blocks, not just the first.
  const prefix = op.idempotencyKey ?? op.text;
  const alreadyPresent = blocks.some(b => isTextBlock(b) && b.text.startsWith(prefix));
  if (alreadyPresent) return blocks;
  return [{
    type: "text",
    text: op.text
  }, ...blocks];
}
function applyAppendSystemBlock(blocks, op) {
  if (!op.text) return blocks;
  // Idempotency: skip if any text block already starts with idempotencyKey (when
  // set) or is an exact match of op.text (default). Scans ALL blocks.
  const prefix = op.idempotencyKey;
  const alreadyPresent = prefix ? blocks.some(b => isTextBlock(b) && b.text.startsWith(prefix)) : blocks.some(b => isTextBlock(b) && b.text === op.text);
  if (alreadyPresent) return blocks;
  return [...blocks, {
    type: "text",
    text: op.text
  }];
}
function applyInjectBillingHeader(body, blocks, op) {
  // No user message → no billing header (ex-machina parity, transform.ts:340).
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const hasUser = messages.some(m => m?.role === "user");
  if (!hasUser) return blocks;
  const headerValue = buildBillingHeaderValue(messages, {
    entrypoint: op.entrypoint,
    versionFormat: op.versionFormat,
    cchAlgo: op.cchAlgo,
    version: op.version
  });

  // Idempotency: replace any existing billing header block (ex-machina + native
  // OAuth path both rebuild on retry; see executors/base.ts issue #1712).
  const headerPrefix = "x-anthropic-billing-header:";
  const filtered = blocks.filter(b => !(isTextBlock(b) && b.text.startsWith(headerPrefix)));
  return [{
    type: "text",
    text: headerValue
  }, ...filtered];
}

// ────────────────────────────────────────────────────────────────────────────
// Pipeline executor
// ────────────────────────────────────────────────────────────────────────────

/**
 * Run the configured transform pipeline against a request body.
 *
 * The body is mutated in place (its `system` field is replaced); returned for
 * chaining. `appliedOpKinds` lists the ops that ran (omitting no-ops when
 * config is disabled). When `config.enabled === false`, the body is returned
 * unchanged and `appliedOpKinds` is empty.
 */
export function applyCcBridgeTransformPipeline(body, config = getCcBridgeTransformsConfig()) {
  if (!body || typeof body !== "object") {
    return {
      body,
      appliedOpKinds: []
    };
  }
  if (!config.enabled || !Array.isArray(config.pipeline) || config.pipeline.length === 0) {
    return {
      body,
      appliedOpKinds: []
    };
  }
  let blocks = normalizeSystemToBlocks(body.system);
  const appliedOpKinds = [];
  for (const op of config.pipeline) {
    switch (op.kind) {
      case "drop_paragraph_if_contains":
        blocks = applyDropParagraphIfContains(blocks, op);
        break;
      case "drop_paragraph_if_starts_with":
        blocks = applyDropParagraphIfStartsWith(blocks, op);
        break;
      case "replace_text":
        blocks = applyReplaceText(blocks, op);
        break;
      case "replace_regex":
        blocks = applyReplaceRegex(blocks, op);
        break;
      case "drop_block_if_contains":
        blocks = applyDropBlockIfContains(blocks, op);
        break;
      case "prepend_system_block":
        blocks = applyPrependSystemBlock(blocks, op);
        break;
      case "append_system_block":
        blocks = applyAppendSystemBlock(blocks, op);
        break;
      case "inject_billing_header":
        blocks = applyInjectBillingHeader(body, blocks, op);
        break;
      default:
        {
          // Unknown op kind — skip silently to keep forward compatibility.
          continue;
        }
    }
    appliedOpKinds.push(op.kind);
  }

  // Drop empty text blocks left behind by paragraph removal (matches
  // ex-machina sanitizeSystemText trim semantics).
  blocks = blocks.filter(b => !isTextBlock(b) || b.text.length > 0);
  body.system = blocks;
  return {
    body,
    appliedOpKinds
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Runtime singleton (mirrors cliFingerprints `_cliCompatProviders` pattern).
// ────────────────────────────────────────────────────────────────────────────

let _runtimeConfig = DEFAULT_CC_BRIDGE_TRANSFORMS_CONFIG;

/**
 * Replace the active CC bridge transforms config. Called from
 * `runtimeSettings.applyCcBridgeTransformsSection()` when the Settings UI
 * saves a new pipeline.
 */
export function setCcBridgeTransformsConfig(config) {
  if (!config) {
    _runtimeConfig = DEFAULT_CC_BRIDGE_TRANSFORMS_CONFIG;
    return;
  }
  _runtimeConfig = {
    enabled: config.enabled !== false,
    pipeline: Array.isArray(config.pipeline) ? config.pipeline : DEFAULT_CC_BRIDGE_PIPELINE
  };
}

/**
 * Read the currently active config (defaults to DEFAULT_CC_BRIDGE_PIPELINE).
 */
export function getCcBridgeTransformsConfig() {
  return _runtimeConfig;
}

/**
 * Reset to defaults — exposed for tests and the Settings UI "Reset" button.
 */
export function resetCcBridgeTransformsConfig() {
  _runtimeConfig = DEFAULT_CC_BRIDGE_TRANSFORMS_CONFIG;
}