import { createHash, randomUUID } from "node:crypto";
import { getStainlessTimeoutSeconds } from "../stubs/shared/utils/runtimeTimeouts";
import { ANTHROPIC_VERSION_HEADER } from "../config/anthropicHeaders";
import { supportsClaudeMaxEffort, supportsXHighEffort } from "../config/providerModels";
import { prepareClaudeRequest } from "../translator/helpers/claudeHelper";
import { signRequestBody } from "./claudeCodeCCH";
import { resolveClaudeCodeCompatibleAnthropicBeta } from "./claudeCodeCompatibleBeta";
import { remapToolNamesInRequest } from "./claudeCodeToolRemapper";
import { enforceThinkingTemperature, disableThinkingIfToolChoiceForced, enforceCacheControlLimit } from "./claudeCodeConstraints";
import { applyClaudeCodeCompatibleThinkingDisplay } from "./claudeCodeCompatibleThinkingDisplay";
import { obfuscateInBody } from "./claudeCodeObfuscation";
import { applySystemTransformPipeline, PROVIDER_CC_BRIDGE } from "./systemTransforms";
import { fixToolPairs, fixToolAdjacency, stripTrailingAssistantOrphanToolUse } from "./contextManager";

/**
 * `anthropic-compatible-cc-*` targets Anthropic relay gateways that only accept
 * traffic which looks like the official Claude Code client, often because those
 * gateways resell the same models at materially lower prices than the direct API.
 *
 * This bridge is intentionally compatibility-first while still preserving as
 * much Claude-native structure as possible. Third-party relays are sensitive to
 * wire-image details, so we only synthesize the minimum required defaults when
 * the caller did not already provide Claude-shaped fields.
 */
export const CLAUDE_CODE_COMPATIBLE_PREFIX = "anthropic-compatible-cc-";
export const CLAUDE_CODE_COMPATIBLE_DEFAULT_CHAT_PATH = "/v1/messages?beta=true";
export const CLAUDE_CODE_COMPATIBLE_DEFAULT_MODELS_PATH = "/models";
export const CLAUDE_CODE_COMPATIBLE_DEFAULT_MAX_TOKENS = 64000;
export const CLAUDE_CODE_COMPATIBLE_ANTHROPIC_VERSION = ANTHROPIC_VERSION_HEADER;
export { CLAUDE_CODE_COMPATIBLE_ANTHROPIC_BETA, CLAUDE_CODE_COMPATIBLE_REDACT_THINKING_BETA, resolveClaudeCodeCompatibleAnthropicBeta } from "./claudeCodeCompatibleBeta";
export const CLAUDE_CODE_COMPATIBLE_VERSION = "2.1.195";
export const CLAUDE_CODE_COMPATIBLE_USER_AGENT = "claude-cli/2.1.195 (external, sdk-cli)";
export const CLAUDE_CODE_COMPATIBLE_STAINLESS_PACKAGE_VERSION = "0.94.0";
export const CLAUDE_CODE_COMPATIBLE_STAINLESS_RUNTIME_VERSION = "v24.3.0";
export const CONTEXT_1M_BETA_HEADER = "context-1m-2025-08-07";
const CLAUDE_CODE_COMPATIBLE_DEFAULT_SYSTEM_BLOCKS = [{
  type: "text",
  text: "You are a Claude agent, built on Anthropic's Claude Agent SDK."
}];
const CONTEXT_1M_SUPPORTED_MODELS = ["claude-fable-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6"];
export const CLAUDE_CODE_COMPATIBLE_STAINLESS_TIMEOUT_SECONDS = getStainlessTimeoutSeconds(process.env);
function supportsClaudeXHighEffort(model) {
  return typeof model === "string" && supportsXHighEffort("claude", model);
}
export function isClaudeCodeCompatibleProvider(provider) {
  return typeof provider === "string" && provider.startsWith(CLAUDE_CODE_COMPATIBLE_PREFIX);
}
export function stripAnthropicMessagesSuffix(baseUrl) {
  const normalized = String(baseUrl || "").trim().replace(/\/$/, "");
  if (!normalized) return "";
  return normalized.split("?")[0].replace(/\/messages$/i, "");
}
export function stripClaudeCodeCompatibleEndpointSuffix(baseUrl) {
  const normalized = String(baseUrl || "").trim().replace(/\/$/, "");
  if (!normalized) return "";
  return normalized.split("?")[0].replace(/\/(?:v\d+\/)?messages$/i, "");
}
function joinNormalizedBaseUrlAndPath(baseUrl, path) {
  const normalizedBase = String(baseUrl || "").replace(/\/$/, "");
  const normalizedPath = String(path || "").startsWith("/") ? String(path) : `/${String(path || "")}`;
  const versionMatch = normalizedBase.match(/(\/v\d+)$/i);
  if (versionMatch && normalizedPath.toLowerCase().startsWith(`${versionMatch[1].toLowerCase()}/`)) {
    return `${normalizedBase}${normalizedPath.slice(versionMatch[1].length)}`;
  }
  return `${normalizedBase}${normalizedPath}`;
}
export function joinBaseUrlAndPath(baseUrl, path) {
  return joinNormalizedBaseUrlAndPath(stripAnthropicMessagesSuffix(baseUrl), path);
}
export function joinClaudeCodeCompatibleUrl(baseUrl, path) {
  return joinNormalizedBaseUrlAndPath(stripClaudeCodeCompatibleEndpointSuffix(baseUrl), path);
}
export function appendAnthropicBetaHeader(headers, betaHeader) {
  const existingKey = Object.keys(headers).find(key => key.toLowerCase() === "anthropic-beta");
  if (!existingKey) {
    headers["anthropic-beta"] = betaHeader;
    return;
  }
  const existingValues = String(headers[existingKey] || "").split(",").map(value => value.trim()).filter(Boolean);
  if (!existingValues.includes(betaHeader)) {
    headers[existingKey] = [...existingValues, betaHeader].join(",");
  }
}
export function modelSupportsContext1mBeta(model) {
  const normalizedModel = String(model || "").trim().toLowerCase().replace(/-\d{8}$/, "");
  return CONTEXT_1M_SUPPORTED_MODELS.some(supported => normalizedModel === supported || normalizedModel.startsWith(`${supported}-`));
}
export function buildClaudeCodeCompatibleHeaders(apiKey, stream = false, sessionId, options = {}) {
  void stream;
  // These headers intentionally mirror Claude Code's wire image closely.
  // For CC-compatible relays, passing the upstream's client-gating checks is
  // more important than forwarding arbitrary caller-specific header shapes.
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${apiKey}`,
    "anthropic-version": CLAUDE_CODE_COMPATIBLE_ANTHROPIC_VERSION,
    "anthropic-beta": resolveClaudeCodeCompatibleAnthropicBeta({
      redactThinking: options.redactThinking === true
    }),
    "anthropic-dangerous-direct-browser-access": "true",
    "x-app": "cli",
    "User-Agent": CLAUDE_CODE_COMPATIBLE_USER_AGENT,
    "X-Stainless-Retry-Count": "0",
    "X-Stainless-Timeout": String(CLAUDE_CODE_COMPATIBLE_STAINLESS_TIMEOUT_SECONDS),
    "X-Stainless-Lang": "js",
    "X-Stainless-Package-Version": CLAUDE_CODE_COMPATIBLE_STAINLESS_PACKAGE_VERSION,
    "X-Stainless-OS": "MacOS",
    "X-Stainless-Arch": "arm64",
    "X-Stainless-Runtime": "node",
    "X-Stainless-Runtime-Version": CLAUDE_CODE_COMPATIBLE_STAINLESS_RUNTIME_VERSION,
    "accept-encoding": "gzip, deflate, br, zstd",
    ...(sessionId ? {
      "X-Claude-Code-Session-Id": sessionId
    } : {})
  };
}
export function buildClaudeCodeCompatibleValidationPayload(model = "claude-sonnet-4-6") {
  const sessionId = randomUUID();
  return buildClaudeCodeCompatibleRequest({
    sourceBody: {
      max_tokens: 1
    },
    normalizedBody: {
      messages: [{
        role: "user",
        content: "ok"
      }],
      max_tokens: 1
    },
    model,
    stream: true,
    sessionId,
    cwd: process.cwd(),
    now: new Date()
  });
}
export function resolveClaudeCodeCompatibleSessionId(headers) {
  const raw = getHeader(headers, "x-claude-code-session-id") || getHeader(headers, "x-session-id") || getHeader(headers, "x_session_id") || getHeader(headers, "x-omniroute-session") || null;
  return raw && raw.trim() || randomUUID();
}
export function buildClaudeCodeCompatibleRequest({
  sourceBody,
  normalizedBody,
  claudeBody,
  model,
  stream = false,
  cwd = process.cwd(),
  sessionId,
  preserveCacheControl = false,
  preserveClaudeMessages = false,
  summarizeThinking = false
}) {
  const normalized = normalizedBody || {};
  const preparedClaudeBody = claudeBody ? preserveClaudeMessages ? prepareClaudeCodeCompatibleSemanticBody(claudeBody) : prepareClaudeCodeCompatibleBody(claudeBody, preserveCacheControl) : null;
  const normalizedMessages = Array.isArray(normalized.messages) ? normalized.messages : [];
  const extractedClaudeBody = !preparedClaudeBody && sourceBody ? extractClaudeBodyFromSource(sourceBody, preserveCacheControl) : null;
  const effectiveClaudeBody = preparedClaudeBody || extractedClaudeBody;
  const messages = effectiveClaudeBody ? preserveClaudeMessages && preparedClaudeBody ? cloneClaudeCodeCompatibleMessagesFromClaude(effectiveClaudeBody.messages, preserveCacheControl) : buildClaudeCodeCompatibleMessagesFromClaude(effectiveClaudeBody.messages, preserveCacheControl) : buildClaudeCodeCompatibleMessages(normalizedMessages);
  const system = buildClaudeCodeCompatibleSystemBlocks({
    messages: preserveClaudeMessages ? [] : normalizedMessages,
    systemBlocks: effectiveClaudeBody?.system,
    preserveCacheControl
  });
  const resolvedSessionId = sessionId || randomUUID();
  const effort = resolveClaudeCodeCompatibleEffort(sourceBody, normalizedBody, model);
  const maxTokens = resolveClaudeCodeCompatibleMaxTokens(sourceBody, normalizedBody);
  const tools = preparedClaudeBody?.tools ? buildClaudeCodeCompatibleToolsFromClaude(preparedClaudeBody.tools, preserveCacheControl) : buildClaudeCodeCompatibleTools(normalizedBody, sourceBody);
  const toolChoice = tools.length > 0 ? buildClaudeCodeCompatibleToolChoice(normalizedBody?.["tool_choice"] ?? sourceBody?.["tool_choice"]) : undefined;
  const metadata = resolveClaudeCodeCompatibleMetadata({
    claudeBody,
    sourceBody,
    normalizedBody,
    cwd,
    sessionId: resolvedSessionId
  });
  const thinking = resolveClaudeCodeCompatibleThinking({
    claudeBody: preparedClaudeBody ?? claudeBody,
    sourceBody,
    normalizedBody,
    summarizeThinking
  });
  const outputConfig = resolveClaudeCodeCompatibleOutputConfig({
    claudeBody,
    sourceBody,
    normalizedBody,
    model,
    effort
  });
  return {
    model,
    messages,
    system,
    tools,
    metadata,
    max_tokens: maxTokens,
    thinking,
    output_config: outputConfig,
    ...(toolChoice ? {
      tool_choice: toolChoice
    } : {}),
    ...(stream ? {
      stream: true
    } : {})
  };
}
export async function buildAndSignClaudeCodeRequest(options) {
  const {
    apiKey,
    enableObfuscation = false,
    ...buildOptions
  } = options;

  // Step 1: Build base request
  const body = buildClaudeCodeCompatibleRequest(buildOptions);

  // Step 2: Remap tool names
  remapToolNamesInRequest(body);

  // Step 3-4: Thinking constraints
  enforceThinkingTemperature(body);
  disableThinkingIfToolChoiceForced(body);

  // Step 5: Cache control
  enforceCacheControlLimit(body);

  // Step 5b: Config-driven system transforms (issue #2260, v2)
  // Normalizes system blocks to classifier-correct structure regardless of
  // source client (OpenCode, Cline, Cursor, Continue, Open WebUI, raw API).
  // Routed via the generic per-provider DSL so the same pipeline shape covers
  // the CC bridge, the native `claude` path, and any other configured
  // provider. Idempotent on re-run.
  {
    const transformResult = applySystemTransformPipeline(PROVIDER_CC_BRIDGE, body);
    if (transformResult.appliedOpKinds.length > 0) {
      console.log(`[SystemTransforms] cc-bridge: ${transformResult.appliedOpKinds.join(", ")}`);
    }
  }

  // Step 5c: Guard against orphan tool_use / tool_result blocks.
  // Anthropic rejects requests where a tool_use has no matching tool_result
  // in the next user message (e.g. `messages.N: tool_use ids were found
  // without tool_result blocks immediately after: toolu_...`). Clients can
  // ship truncated histories mid-tool-call; fixToolPairs strips orphans
  // (preserving final-message tool_use for in-flight rounds), then
  // stripTrailingAssistantOrphanToolUse catches the case where the request
  // body itself ends on an unmatched assistant(tool_use) — invalid for an
  // upstream-send turn since the body must end on a user message.
  // Both are idempotent on clean histories.
  {
    const b = body;
    if (Array.isArray(b.messages)) {
      const fixed = fixToolPairs(b.messages);
      const adjacent = fixToolAdjacency(fixed);
      // fixToolAdjacency can leave orphan tool_result blocks behind when it
      // strips a tool_use whose tool_result wasn't in the next message.
      // Re-pair to drop those orphans (discussion #2410).
      const cleaned = fixToolPairs(adjacent);
      b.messages = stripTrailingAssistantOrphanToolUse(cleaned);
    }
  }

  // Step 6: Obfuscation (optional, per-provider setting)
  if (enableObfuscation) {
    obfuscateInBody(body);
  }

  // Step 7: Serialize with CCH placeholder (strip internal sentinel fields)
  delete body["_claudeCodeRequiresLowercaseToolNames"];
  const serialized = JSON.stringify(body);

  // Step 8: Sign with xxHash64
  const bodyString = await signRequestBody(serialized);

  // Build headers
  const sessionId = options.sessionId || resolveClaudeCodeCompatibleSessionId();
  const headers = buildClaudeCodeCompatibleHeaders(apiKey, options.stream ?? false, sessionId, {
    redactThinking: buildOptions.redactThinking === true
  });
  return {
    bodyString,
    headers
  };
}

/**
 * Re-export for consumers that need to post-process SSE response chunks.
 */
export { remapToolNamesInResponse } from "./claudeCodeToolRemapper";
export { signRequestBody } from "./claudeCodeCCH";
export { computeFingerprint } from "./claudeCodeFingerprint";
export { obfuscateSensitiveWords, setSensitiveWords } from "./claudeCodeObfuscation";
export { enforceThinkingTemperature, disableThinkingIfToolChoiceForced, enforceCacheControlLimit } from "./claudeCodeConstraints";
// Preferred (v2): generic per-provider DSL.
export { applySystemTransformPipeline, setSystemTransformsConfig, getSystemTransformsConfig, resetSystemTransformsConfig, DEFAULT_SYSTEM_TRANSFORMS_CONFIG, DEFAULT_CLAUDE_PIPELINE, DEFAULT_CC_BRIDGE_PROVIDER_PIPELINE, DEFAULT_OBFUSCATE_WORDS, OPENWEBUI_PARAGRAPH_ANCHORS, OPENWEBUI_IDENTITY_PREFIXES, PROVIDER_CLAUDE, PROVIDER_CC_BRIDGE } from "./systemTransforms";
// Legacy (deprecated, kept for transitional API consumers).
// The base executor is still used internally by systemTransforms.ts;
// these exports let downstream code reference the building blocks directly
// while we migrate UI + settings to the v2 shape.
export { applyCcBridgeTransformPipeline, buildBillingHeaderValue, setCcBridgeTransformsConfig, getCcBridgeTransformsConfig, resetCcBridgeTransformsConfig, DEFAULT_CC_BRIDGE_PIPELINE, DEFAULT_PARAGRAPH_REMOVAL_ANCHORS, DEFAULT_IDENTITY_PREFIXES, DEFAULT_TEXT_REPLACEMENTS, CLAUDE_AGENT_SDK_IDENTITY } from "./ccBridgeTransforms";
export function resolveClaudeCodeCompatibleEffort(sourceBody, normalizedBody, model) {
  const raw = readNestedString(sourceBody, ["output_config", "effort"]) || readNestedString(sourceBody, ["reasoning", "effort"]) || toNonEmptyString(sourceBody?.["reasoning_effort"]) || readNestedString(normalizedBody, ["output_config", "effort"]) || readNestedString(normalizedBody, ["reasoning", "effort"]) || toNonEmptyString(normalizedBody?.["reasoning_effort"]) || "";
  const normalizedEffort = raw.toLowerCase();
  if (!normalizedEffort) {
    return supportsClaudeXHighEffort(model) ? "xhigh" : "high";
  }
  if (normalizedEffort === "low") return "low";
  if (normalizedEffort === "medium") return "medium";
  if (normalizedEffort === "high") return "high";
  if (normalizedEffort === "none" || normalizedEffort === "disabled") return "low";
  if (normalizedEffort === "xhigh") {
    return supportsClaudeXHighEffort(model) ? "xhigh" : "high";
  }
  if (normalizedEffort === "max") {
    return supportsClaudeMaxEffort(model) ? "max" : "high";
  }
  return supportsClaudeXHighEffort(model) ? "xhigh" : "high";
}
export function resolveClaudeCodeCompatibleMaxTokens(sourceBody, normalizedBody) {
  const candidates = [sourceBody?.["max_tokens"], sourceBody?.["max_completion_tokens"], sourceBody?.["max_output_tokens"], normalizedBody?.["max_tokens"], normalizedBody?.["max_completion_tokens"], normalizedBody?.["max_output_tokens"]];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value > 0) {
      return Math.floor(value);
    }
  }
  return CLAUDE_CODE_COMPATIBLE_DEFAULT_MAX_TOKENS;
}
function buildClaudeCodeCompatibleMessages(messages) {
  const converted = messages.map(message => convertClaudeCodeCompatibleMessage(message)).filter(message => !!message && message.content.length > 0);
  const merged = [];
  for (const message of converted) {
    const last = merged[merged.length - 1];
    if (last && last.role === message.role) {
      last.content.push(...message.content);
      continue;
    }
    merged.push({
      role: message.role,
      content: [...message.content]
    });
  }

  // CC-compatible sites we tested reject assistant-prefill shaped requests even
  // when Anthropic would normally allow them. Keep assistant/model history, but
  // drop trailing assistant turns so the upstream request ends on a user turn.
  while (merged.length > 0 && merged[merged.length - 1].role === "assistant") {
    merged.pop();
  }
  if (merged.length === 0) {
    const fallbackText = converted.flatMap(message => message.content).map(block => toNonEmptyString(block.text)).filter(Boolean).join("\n").trim();
    if (fallbackText) {
      return [{
        role: "user",
        content: [{
          type: "text",
          text: fallbackText
        }]
      }];
    }
  }
  return merged;
}
function buildClaudeCodeCompatibleMessagesFromClaude(messages, preserveCacheControl) {
  const converted = Array.isArray(messages) ? messages.map(message => convertClaudeCodeCompatibleClaudeMessage(message, preserveCacheControl)).filter(message => !!message && message.content.length > 0) : [];
  const merged = [];
  let previousAssistantHadToolUse = false;
  for (const message of converted) {
    const hasToolUse = message.content.some(block => block.type === "tool_use");
    const hasToolResult = message.content.some(block => block.type === "tool_result");
    const last = merged[merged.length - 1];
    const shouldKeepSeparate = hasToolUse || hasToolResult || previousAssistantHadToolUse || last?.content?.some(block => block.type === "tool_use") || last?.content?.some(block => block.type === "tool_result");
    if (last && last.role === message.role && !shouldKeepSeparate) {
      last.content.push(...message.content);
    } else {
      merged.push({
        role: message.role,
        content: [...message.content]
      });
    }
    previousAssistantHadToolUse = message.role === "assistant" && hasToolUse;
  }
  while (merged.length > 0) {
    const last = merged[merged.length - 1];
    const hasToolUse = last.content.some(block => block.type === "tool_use");
    if (last.role !== "assistant" || hasToolUse) {
      break;
    }
    merged.pop();
  }
  if (!preserveCacheControl) {
    for (const message of merged) {
      stripCacheControlFromContentBlocks(message.content);
    }
  }
  if (merged.length === 0) {
    const fallbackText = converted.flatMap(message => message.content).map(block => contentToText(block)).filter(Boolean).join("\n").trim();
    if (fallbackText) {
      return [{
        role: "user",
        content: [{
          type: "text",
          text: fallbackText
        }]
      }];
    }
  }
  return merged;
}
function cloneClaudeCodeCompatibleMessagesFromClaude(messages, preserveCacheControl) {
  const cloned = Array.isArray(messages) ? messages.map(message => cloneValue(message)).filter(message => {
    const role = String(message?.role || "").toLowerCase();
    return role !== "system" && role !== "developer";
  }) : [];
  if (!preserveCacheControl) {
    for (const message of cloned) {
      if (Array.isArray(message.content)) {
        stripCacheControlFromContentBlocks(message.content);
      }
    }
  }
  return cloned;
}
function buildClaudeCodeCompatibleSystemBlocks({
  messages,
  systemBlocks,
  preserveCacheControl
}) {
  const customSystemBlocks = Array.isArray(systemBlocks) && systemBlocks.length > 0 ? systemBlocks.map(block => ({
    ...block
  })) : extractCustomSystemBlocks(messages);
  const preparedCustomSystemBlocks = customSystemBlocks.map(systemBlock => {
    const preparedBlock = {
      ...systemBlock
    };
    if (!preserveCacheControl) {
      delete preparedBlock["cache_control"];
    }
    return preparedBlock;
  });
  const hasDefaultSystemBlock = containsDefaultSystemSkeleton(preparedCustomSystemBlocks);
  if (hasDefaultSystemBlock) return preparedCustomSystemBlocks;
  return [...CLAUDE_CODE_COMPATIBLE_DEFAULT_SYSTEM_BLOCKS.map(block => ({
    ...block
  })), ...preparedCustomSystemBlocks];
}
function containsDefaultSystemSkeleton(blocks) {
  const skeleton = CLAUDE_CODE_COMPATIBLE_DEFAULT_SYSTEM_BLOCKS;
  if (skeleton.length === 0) return true;
  if (blocks.length < skeleton.length) return false;
  return blocks.some((_, startIndex) => skeleton.every((defaultBlock, offset) => {
    const candidateBlock = blocks[startIndex + offset];
    if (!candidateBlock) return false;
    return Object.entries(defaultBlock).every(([key, value]) => candidateBlock[key] === value);
  }));
}
function convertClaudeCodeCompatibleMessage(message) {
  const rawRole = String(message?.role || "").toLowerCase();
  const role = rawRole === "user" ? "user" : rawRole === "assistant" || rawRole === "model" ? "assistant" : null;
  if (!role) return null;
  const text = contentToText(message?.content);
  if (!text) return null;
  return {
    role,
    content: [{
      type: "text",
      text
    }]
  };
}
function buildClaudeCodeCompatibleTools(normalizedBody, sourceBody) {
  const rawTools = Array.isArray(normalizedBody?.["tools"]) ? normalizedBody?.["tools"] : Array.isArray(sourceBody?.["tools"]) ? sourceBody?.["tools"] : [];
  return rawTools.map(tool => convertClaudeCodeCompatibleTool(tool)).filter(tool => !!tool).map(tool => ({
    ...tool
  }));
}
function buildClaudeCodeCompatibleToolsFromClaude(tools, preserveCacheControl) {
  if (!Array.isArray(tools)) return [];
  return tools.map(tool => {
    const preparedTool = {
      ...tool
    };
    if (!preserveCacheControl) {
      delete preparedTool.cache_control;
    }
    return preparedTool;
  });
}
function convertClaudeCodeCompatibleTool(tool) {
  const rawTool = readRecord(tool);
  if (!rawTool) return null;
  const toolData = rawTool.type === "function" ? readRecord(rawTool.function) || rawTool : rawTool;
  const name = toNonEmptyString(toolData.name);
  if (!name) return null;
  const rawSchema = readRecord(toolData.parameters) || readRecord(toolData.input_schema) || {
    type: "object",
    properties: {},
    required: []
  };
  const inputSchema = rawSchema.type === "object" && !readRecord(rawSchema.properties) ? {
    ...rawSchema,
    properties: {}
  } : rawSchema;
  const converted = {
    name,
    description: toNonEmptyString(toolData.description) || "",
    input_schema: inputSchema
  };
  if (typeof toolData.defer_loading === "boolean") {
    converted.defer_loading = toolData.defer_loading;
  }
  return converted;
}
function buildClaudeCodeCompatibleToolChoice(choice) {
  if (!choice) return null;
  if (typeof choice === "string") {
    if (choice === "required") return {
      type: "any"
    };
    return null;
  }
  const rawChoice = readRecord(choice);
  if (!rawChoice) return null;
  if (rawChoice.type === "tool") {
    const name = toNonEmptyString(rawChoice.name);
    return name ? {
      type: "tool",
      name
    } : null;
  }
  if (rawChoice.type === "function") {
    const functionName = toNonEmptyString(readRecord(rawChoice.function)?.name) || toNonEmptyString(rawChoice.name);
    return functionName ? {
      type: "tool",
      name: functionName
    } : null;
  }
  if (rawChoice.type === "required" || rawChoice.type === "any") {
    return {
      type: "any"
    };
  }
  return null;
}
function prepareClaudeCodeCompatibleBody(claudeBody, preserveCacheControl) {
  void preserveCacheControl;
  const prepared = prepareClaudeRequest({
    system: normalizeClaudeSystemInput(claudeBody.system),
    messages: normalizeClaudeMessageInput(claudeBody.messages),
    tools: normalizeClaudeToolInput(claudeBody.tools),
    thinking: readRecord(claudeBody.thinking) || null
  }, CLAUDE_CODE_COMPATIBLE_PREFIX, true);
  return readRecord(prepared);
}
function prepareClaudeCodeCompatibleSemanticBody(claudeBody) {
  const rawMessages = Array.isArray(claudeBody.messages) ? claudeBody.messages : [];
  const systemBlocks = normalizeClaudeSystemInput(claudeBody.system);
  const systemFromMessages = extractCustomSystemBlocks(rawMessages);
  const mergedSystem = [...systemBlocks, ...systemFromMessages];
  const normalizedMessages = rawMessages.filter(message => {
    const role = String(message?.role || "").toLowerCase();
    return role !== "system" && role !== "developer";
  });
  const prepared = {
    system: mergedSystem,
    messages: normalizedMessages,
    tools: normalizeClaudeToolInput(claudeBody.tools),
    thinking: readRecord(cloneValue(claudeBody.thinking)) || null
  };
  const metadata = readRecord(cloneValue(claudeBody.metadata));
  if (metadata) prepared.metadata = metadata;
  const outputConfig = readRecord(cloneValue(claudeBody.output_config));
  if (outputConfig) prepared.output_config = outputConfig;
  return prepared;
}
function extractClaudeBodyFromSource(sourceBody, preserveCacheControl) {
  const rawMessages = Array.isArray(sourceBody.messages) ? sourceBody.messages : [];
  const hasSystemRoleMessages = rawMessages.some(message => {
    const role = String(message?.role || "").toLowerCase();
    return role === "system" || role === "developer";
  });
  const hasClaudeSystem = typeof sourceBody.system === "string" || Array.isArray(sourceBody.system) && sourceBody.system.length > 0;
  if (!hasClaudeSystem && !hasSystemRoleMessages) {
    return null;
  }
  const normalizedMessages = rawMessages.filter(message => {
    const role = String(message?.role || "").toLowerCase();
    return role !== "system" && role !== "developer";
  });
  return prepareClaudeCodeCompatibleBody({
    ...sourceBody,
    ...(hasClaudeSystem ? {} : {
      system: extractCustomSystemBlocks(rawMessages)
    }),
    messages: normalizedMessages
  }, preserveCacheControl);
}
function normalizeClaudeSystemInput(system) {
  if (typeof system === "string") {
    const text = system.trim();
    return text ? [{
      type: "text",
      text
    }] : [];
  }
  if (!Array.isArray(system)) return [];
  return system.map(block => normalizeClaudeContentBlock(block)).filter(block => !!block);
}
function normalizeClaudeMessageInput(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map(message => {
    const record = readRecord(message);
    if (!record) return null;
    return {
      ...record,
      content: normalizeClaudeContentInput(record.content)
    };
  }).filter(message => !!message);
}
function normalizeClaudeToolInput(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.map(tool => readRecord(cloneValue(tool))).filter(tool => !!tool);
}
function normalizeClaudeContentInput(content) {
  const blocks = normalizeClaudeContentBlocks(content);
  return blocks.length > 0 ? blocks : content;
}
function normalizeClaudeContentBlocks(content) {
  if (typeof content === "string") {
    const text = content.trim();
    return text ? [{
      type: "text",
      text
    }] : [];
  }
  if (!Array.isArray(content)) {
    const block = normalizeClaudeContentBlock(content);
    return block ? [block] : [];
  }
  return content.map(block => normalizeClaudeContentBlock(block)).filter(block => !!block);
}
function normalizeClaudeContentBlock(block) {
  const record = readRecord(cloneValue(block));
  if (!record) return null;
  if (record.type === "text" || typeof record.type !== "string" && typeof record.text === "string") {
    const text = toNonEmptyString(record.text);
    if (!text) return null;
    return {
      ...record,
      type: "text",
      text
    };
  }
  return record;
}
function convertClaudeCodeCompatibleClaudeMessage(message, preserveCacheControl) {
  const rawRole = String(message?.role || "").toLowerCase();
  const role = rawRole === "user" ? "user" : rawRole === "assistant" ? "assistant" : null;
  if (!role) return null;
  const content = normalizeClaudeContentBlocks(message?.content).map(block => {
    if (preserveCacheControl) return block;
    const {
      cache_control,
      ...rest
    } = block;
    return rest;
  });
  if (content.length === 0) return null;
  return {
    role,
    content
  };
}
function extractCustomSystemBlocks(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.filter(message => {
    const role = String(message?.role || "").toLowerCase();
    return role === "system" || role === "developer";
  }).map(message => contentToText(message?.content)).filter(Boolean).map(text => ({
    type: "text",
    text
  }));
}
function stripCacheControlFromContentBlocks(content) {
  for (const block of content) {
    delete block.cache_control;
  }
}
function resolveClaudeCodeCompatibleMetadata({
  claudeBody,
  sourceBody,
  normalizedBody,
  cwd,
  sessionId
}) {
  const metadata = readRecord(cloneValue(claudeBody?.metadata)) || readRecord(cloneValue(sourceBody?.metadata)) || readRecord(cloneValue(normalizedBody?.metadata)) || {};
  if (!toNonEmptyString(metadata.user_id)) {
    metadata.user_id = JSON.stringify({
      device_id: createHash("sha256").update(String(cwd || "")).digest("hex"),
      account_uuid: "",
      session_id: sessionId
    });
  }
  return metadata;
}
function resolveClaudeCodeCompatibleThinking({
  claudeBody,
  sourceBody,
  normalizedBody,
  summarizeThinking = false
}) {
  const thinking = readRecord(cloneValue(claudeBody?.thinking)) || readRecord(cloneValue(sourceBody?.thinking)) || readRecord(cloneValue(normalizedBody?.thinking));
  if (thinking) {
    return applyClaudeCodeCompatibleThinkingDisplay(thinking, {
      normalizedBody,
      summarizeThinking
    });
  }
  return applyClaudeCodeCompatibleThinkingDisplay({
    type: "adaptive"
  }, {
    normalizedBody,
    summarizeThinking
  });
}
function resolveClaudeCodeCompatibleOutputConfig({
  claudeBody,
  sourceBody,
  normalizedBody,
  model,
  effort
}) {
  const outputConfig = readRecord(cloneValue(claudeBody?.output_config)) || readRecord(cloneValue(sourceBody?.output_config)) || readRecord(cloneValue(normalizedBody?.output_config)) || {};
  return {
    ...outputConfig,
    effort: resolveClaudeCodeCompatibleEffort(sourceBody, normalizedBody, model) || effort
  };
}
function cloneValue(value) {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}
function contentToText(content) {
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content.map(part => {
      if (!part || typeof part !== "object") return "";
      const record = part;
      if (record.type === "text" && typeof record.text === "string") {
        return record.text.trim();
      }
      if (typeof record.text === "string") {
        return record.text.trim();
      }
      return "";
    }).filter(Boolean).join("\n").trim();
  }
  if (content && typeof content === "object") {
    const record = content;
    if (typeof record.text === "string") return record.text.trim();
  }
  return "";
}
function getHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") {
    return headers.get(name);
  }
  const record = headers;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === target) {
      return value ?? null;
    }
  }
  return null;
}
function toNonEmptyString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}
function readRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function readNestedString(source, path) {
  let current = source;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return null;
    }
    if (key === "__proto__" || key === "constructor" || key === "prototype") return null;
    if (!Object.prototype.hasOwnProperty.call(current, key)) return null;
    current = Reflect.get(current, key);
  }
  return toNonEmptyString(current);
}