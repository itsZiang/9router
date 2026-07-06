import { register } from "../registry";
import { FORMATS } from "../formats";
import { ANTIGRAVITY_DEFAULT_SYSTEM } from "../../config/constants";
import { buildGeminiThoughtSignatureKey, resolveGeminiThoughtSignature } from "../../services/geminiThoughtSignatureStore";
import { generateAntigravityRequestId, getAntigravityEnvelopeUserAgent, getAntigravitySessionId } from "../../services/antigravityIdentity";
import { capMaxOutputTokens, capThinkingBudget, getDefaultThinkingBudget } from "../../stubs/lib/modelCapabilities";
import { DEFAULT_SAFETY_SETTINGS, convertOpenAIContentToParts, extractTextContent, tryParseJSON, cleanJSONSchemaForAntigravity } from "../helpers/geminiHelper";
import { buildGeminiTools, sanitizeGeminiToolName } from "../helpers/geminiToolsSanitizer";
import { isVertexGeminiProvider, buildChangedToolNameMap, extractClientThoughtSignature, deepCleanUndefined, applyAntigravityGenerationDefaults, buildInertHistoricalToolCallText, buildInertHistoricalToolResponseText, buildHistoricalToolResultContext } from "./openai-to-gemini/helpers";

// Observed Antigravity wrapper output cap, not an underlying model capability.
// Keep this bridge-local: Antigravity currently caps visible output around 16K.
// See: https://github.com/keisksw/antigravity-output-analysis
const ANTIGRAVITY_CLAUDE_MAX_OUTPUT_TOKENS = 16_384;

// Gemini built-in tool names that Antigravity's v1internal endpoint rejects with a
// 400 when they are mixed with functionDeclarations in the same request. These must
// be stripped from the Cloud Code envelope's functionDeclarations.
const GEMINI_BUILTIN_TOOL_NAMES = new Set(["google_search", "web_search", "search_web", "googleSearch"]);
// Gemini-family APIs (incl. Antigravity / Vertex) reject a `contents[]` array that
// has two adjacent entries with the same role:
//   400 INVALID_ARGUMENT "Request contains consecutive messages with the same role".
// Client history that carries consecutive user turns — or a tool-result turn (mapped
// to role:"user") immediately followed by a plain user turn — would otherwise leak
// that invalid alternation through. Merge adjacent same-role entries by concatenating
// their parts, the same normalization the Kiro and Claude request paths already apply
// (9router#2191).
export function mergeConsecutiveSameRoleContents(contents) {
  const merged = [];
  for (const entry of contents) {
    const last = merged[merged.length - 1];
    if (last && last.role === entry.role) {
      last.parts.push(...entry.parts);
    } else {
      // Shallow-copy the entry and its `parts` array so a later same-role merge
      // (`last.parts.push(...)`) never mutates the caller's input objects.
      merged.push({
        ...entry,
        parts: [...entry.parts]
      });
    }
  }
  return merged;
}

// Core: Convert OpenAI request to Gemini format (base for all variants)
function openaiToGeminiBase(model, body, stream, toolNameOptions = {}) {
  const result = {
    model: model,
    contents: [],
    generationConfig: {},
    safetySettings: body.safetySettings || DEFAULT_SAFETY_SETTINGS
  };
  const toolNameMap = new Map();
  const sanitizeToolName = name => sanitizeGeminiToolName(name, {
    ...toolNameOptions,
    toolNameMap
  });

  // Preserve cachedContent if provided by client (for explicit Gemini caching)
  if (body.cachedContent) {
    result.cachedContent = body.cachedContent;
  }

  // Generation config
  if (body.temperature !== undefined) {
    result.generationConfig.temperature = body.temperature;
  }
  if (body.top_p !== undefined) {
    result.generationConfig.topP = body.top_p;
  }
  if (body.top_k !== undefined) {
    result.generationConfig.topK = body.top_k;
  }
  if (body.stop !== undefined) {
    result.generationConfig.stopSequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  }
  const maxOutputTokens = capMaxOutputTokens(model, body.max_tokens ?? body.max_completion_tokens);
  if (maxOutputTokens !== null) {
    result.generationConfig.maxOutputTokens = maxOutputTokens;
  }

  // Thinking / Reasoning support (Google Gemini 2.0+ Thinking models)
  // 1. OpenAI format: reasoning_effort (low/medium/high/auto/max/xhigh)
  // "auto", "max", and "xhigh" are clamped to the high-tier budget because Gemini
  // does not accept these strings directly. "auto" signals "use max reasonable effort"
  // which maps to high. "max"/"xhigh" exceed Gemini's accepted range and are clamped.
  // Port of decolua/9router#2043 by @nguyenxvotanminh3.
  if (body.reasoning_effort) {
    const highBudget = capThinkingBudget(model, 32768);
    const budgetMap = {
      low: 1024,
      medium: getDefaultThinkingBudget(model) || 8192,
      high: highBudget,
      auto: highBudget,
      max: highBudget,
      xhigh: highBudget
    };
    const budget = budgetMap[body.reasoning_effort] ?? getDefaultThinkingBudget(model) ?? 8192;
    result.generationConfig.thinkingConfig = {
      thinkingBudget: budget,
      includeThoughts: true
    };
  }
  // 2. Claude format: thinking (type: enabled, budget_tokens)
  const thinking = body.thinking;
  if (thinking?.type === "enabled" && thinking.budget_tokens) {
    result.generationConfig.thinkingConfig = {
      thinkingBudget: thinking.budget_tokens,
      includeThoughts: true
    };
  }

  // 3. Default: all modern Gemini models (2.5+) have thinking capability.
  // If the client didn't explicitly request thinking (via reasoning_effort or
  // thinking.type), still set includeThoughts so the upstream marks thought
  // parts with thought:true. Without this, the model's reasoning leaks into
  // visible content instead of being routed to reasoning_content by the
  // response translator. (#4170)
  if (!result.generationConfig.thinkingConfig) {
    const modelLower = model.toLowerCase();
    if (modelLower.includes("gemini") && !modelLower.includes("gemini-1") && (!modelLower.includes("gemini-2.0") || modelLower.includes("thinking"))) {
      result.generationConfig.thinkingConfig = {
        thinkingBudget: getDefaultThinkingBudget(model) || capThinkingBudget(model, 24576),
        includeThoughts: true
      };
    }
  }

  // Build tool_call_id -> name map
  const tcID2Name = {};
  const messages = body.messages;
  if (messages && Array.isArray(messages)) {
    for (const msg of messages) {
      const toolCalls = msg.tool_calls;
      if (msg.role === "assistant" && toolCalls) {
        for (const tc of toolCalls) {
          const fn = tc.function;
          if (tc.type === "function" && tc.id && fn?.name) {
            tcID2Name[tc.id] = fn.name;
          }
        }
      }
    }
  }

  // Build tool responses cache
  const toolResponses = {};
  if (messages && Array.isArray(messages)) {
    for (const msg of messages) {
      if (msg.role === "tool" && msg.tool_call_id) {
        toolResponses[msg.tool_call_id] = msg.content;
      }
    }
  }

  // Convert messages
  if (messages && Array.isArray(messages)) {
    for (const msg of messages) {
      const role = msg.role;
      const content = msg.content;
      if (role === "system" && messages.length > 1) {
        const systemText = typeof content === "string" ? content : extractTextContent(content);
        if (systemText) {
          if (!result.systemInstruction) {
            result.systemInstruction = {
              role: "system",
              parts: [{
                text: systemText
              }]
            };
          } else {
            result.systemInstruction.parts.push({
              text: systemText
            });
          }
        }
      } else if (role === "user" || role === "system" && messages.length === 1) {
        const parts = convertOpenAIContentToParts(content);
        if (parts.length > 0) {
          result.contents.push({
            role: "user",
            parts
          });
        }
      } else if (role === "assistant") {
        const parts = [];

        // Thinking/reasoning → thought part with signature
        if (msg.reasoning_content) {
          parts.push({
            thought: true,
            text: msg.reasoning_content
          });
        }
        if (content) {
          const text = typeof content === "string" ? content : extractTextContent(content);
          if (text) {
            parts.push({
              text
            });
          }
        }
        const toolCalls = msg.tool_calls;
        if (toolCalls && Array.isArray(toolCalls)) {
          const toolCallIds = [];
          const resolvedSignatures = new Map();
          let firstPersistedSignature;
          for (const tc of toolCalls) {
            const id = tc.id;
            const resolved = resolveGeminiThoughtSignature(buildGeminiThoughtSignatureKey(toolNameOptions.signatureNamespace, id), extractClientThoughtSignature(tc));
            if (typeof resolved === "string" && resolved.length > 0) {
              resolvedSignatures.set(id, resolved);
              firstPersistedSignature ??= resolved;
            }
          }
          let shouldUseEmbeddedSignature = !parts.some(p => p.thoughtSignature);
          const signaturelessToolCallMode = toolNameOptions.signaturelessToolCallMode;
          const stringifySignaturelessToolCalls = signaturelessToolCallMode === "text";
          const contextualizeSignaturelessToolResponses = signaturelessToolCallMode === "text" || signaturelessToolCallMode === "context";
          for (const tc of toolCalls) {
            if (tc.type !== "function") continue;
            const id = tc.id;
            const fn = tc.function;
            if (!fn) continue;
            const signatureForToolCall = resolvedSignatures.get(id);

            // Non-bypass paths (standard Gemini direct, mode "text"/"context")
            // cannot send a thoughtSignature and reject signature-less native tool
            // parts, so historical signature-less tool calls are represented as
            // inert text/context (#3358). The Antigravity/CLI bypass path
            // (supportsSignatureBypass) instead emits native parts carrying the
            // skip_thought_signature_validator sentinel below.
            if (!toolNameOptions.supportsSignatureBypass) {
              if (!signatureForToolCall && contextualizeSignaturelessToolResponses) {
                if (!toolCallIds.includes(id)) toolCallIds.push(id);
              }
              if (!signatureForToolCall && stringifySignaturelessToolCalls) {
                parts.push({
                  text: buildInertHistoricalToolCallText(fn.name, fn.arguments || "{}")
                });
                continue;
              }
              if (!signatureForToolCall && signaturelessToolCallMode === "context") {
                continue;
              }
            }
            const args = tryParseJSON(fn.arguments || "{}");
            const embeddedThoughtSignature = shouldUseEmbeddedSignature ? firstPersistedSignature || signatureForToolCall : undefined;
            if (embeddedThoughtSignature) {
              shouldUseEmbeddedSignature = false;
            }

            // Gemini expects the signature on the functionCall part itself.
            // If we are in a mode where missing signatures cause 400s (and we couldn't find one),
            // safely default to the bypass string to protect against 400s.
            const finalSignature = embeddedThoughtSignature || (toolNameOptions.supportsSignatureBypass && signaturelessToolCallMode !== "text" ? "skip_thought_signature_validator" : undefined);
            parts.push({
              ...(finalSignature ? {
                thoughtSignature: finalSignature
              } : {}),
              functionCall: {
                ...(toolNameOptions.stripFunctionCallId ? {} : {
                  id: id
                }),
                name: sanitizeToolName(fn.name),
                args: args
              }
            });

            // Bypass path always emits the native response; non-bypass keeps the
            // contextualize-aware bookkeeping (signature-less ids handled as text).
            if (toolNameOptions.supportsSignatureBypass || !contextualizeSignaturelessToolResponses || signatureForToolCall) {
              toolCallIds.push(id);
            }
          }
          if (parts.length > 0) {
            result.contents.push({
              role: "model",
              parts
            });
          }

          // Check if there are actual tool responses in the next messages
          const hasSignaturelessTextResponses = contextualizeSignaturelessToolResponses && toolCalls.some(tc => {
            const id = tc.id;
            return tc.type === "function" && !resolvedSignatures.has(id) && toolResponses[id];
          });
          const hasActualResponses = toolCallIds.some(fid => toolResponses[fid]) || hasSignaturelessTextResponses;
          if (hasActualResponses) {
            const toolParts = [];
            for (const fid of toolCallIds) {
              if (!toolResponses[fid]) continue;
              if (!toolNameOptions.supportsSignatureBypass && contextualizeSignaturelessToolResponses && !resolvedSignatures.has(fid)) continue;
              let name = tcID2Name[fid];
              if (!name) {
                const idParts = fid.split("-");
                if (idParts.length > 2) {
                  name = idParts.slice(0, -2).join("-");
                } else {
                  name = fid;
                }
              }
              name = sanitizeToolName(name);
              const resp = toolResponses[fid];
              let parsedResp = tryParseJSON(resp);
              if (parsedResp === null) {
                parsedResp = {
                  result: resp
                };
              } else if (typeof parsedResp !== "object") {
                parsedResp = {
                  result: parsedResp
                };
              }
              toolParts.push({
                functionResponse: {
                  ...(toolNameOptions.stripFunctionCallId ? {} : {
                    id: fid
                  }),
                  name: name,
                  response: {
                    result: parsedResp
                  }
                }
              });
            }
            if (!toolNameOptions.supportsSignatureBypass && contextualizeSignaturelessToolResponses) {
              // Signature-less historical tool responses are represented as text
              // so strict standard-Gemini endpoints don't reject them as native
              // functionResponse parts missing a matching thoughtSignature.
              // In context mode the matching historical functionCall is omitted,
              // avoiding pseudo tool-call records that Gemini Flash can repeat as
              // the visible final answer.
              for (const tc of toolCalls) {
                const id = tc.id;
                if (tc.type !== "function" || !id) continue;
                if (!resolvedSignatures.has(id) && toolResponses[id]) {
                  const fn = tc.function;
                  const name = tcID2Name[id] || fn?.name || "unknown";
                  const resp = toolResponses[id];
                  toolParts.push({
                    text: signaturelessToolCallMode === "text" ? buildInertHistoricalToolResponseText(name, resp) : buildHistoricalToolResultContext(name, resp)
                  });
                }
              }
            }
            if (toolParts.length > 0) {
              result.contents.push({
                role: "user",
                parts: toolParts
              });
            }
          }
        } else if (parts.length > 0) {
          result.contents.push({
            role: "model",
            parts
          });
        }
      }
    }
  }

  // Collapse any consecutive same-role contents Gemini would reject (9router#2191).
  result.contents = mergeConsecutiveSameRoleContents(result.contents ?? []);

  // Convert tools
  const bodyTools = body.tools;
  const geminiTools = buildGeminiTools(bodyTools, {
    ...toolNameOptions,
    toolNameMap
  });

  // Support for Google Search grounding if requested via 'google_search' tool
  const hasGoogleSearch = bodyTools?.some(t => {
    const fn = t.function;
    return t.type === "function" && (fn?.name === "google_search" || fn?.name === "googleSearch");
  });
  if (geminiTools && geminiTools.length > 0) {
    result.tools = geminiTools;
    if (hasGoogleSearch) {
      result.tools.push({
        googleSearch: {}
      });
    }
    result.toolConfig = {
      functionCallingConfig: {
        mode: "VALIDATED"
      }
    };
  } else if (hasGoogleSearch) {
    result.tools = [{
      googleSearch: {}
    }];
  }

  // Convert response_format to Gemini's responseMimeType/responseSchema
  const responseFormat = body.response_format;
  if (responseFormat) {
    if (responseFormat.type === "json_schema" && responseFormat.json_schema) {
      result.generationConfig.responseMimeType = "application/json";
      // Extract the schema (may be nested under .schema key)
      const schema = responseFormat.json_schema.schema || responseFormat.json_schema;
      if (schema && typeof schema === "object") {
        result.generationConfig.responseSchema = cleanJSONSchemaForAntigravity(schema);
      }
    } else if (responseFormat.type === "json_object") {
      result.generationConfig.responseMimeType = "application/json";
    } else if (responseFormat.type === "text") {
      result.generationConfig.responseMimeType = "text/plain";
    }
  }
  const changedToolNameMap = buildChangedToolNameMap(toolNameMap);
  if (changedToolNameMap) {
    result._toolNameMap = changedToolNameMap;
  }
  deepCleanUndefined(result);
  return result;
}

// OpenAI -> Gemini (standard API)
export function openaiToGeminiRequest(model, body, stream, credentials = null, options = {}) {
  // Thread the signature namespace so a thinking model's thoughtSignature (cached on the
  // response turn under `<connectionId>:<toolCallId>`) is found and re-attached to the
  // functionCall on the follow-up request. Without this the streaming lookup key didn't
  // match and Gemini rejected tool calls with 400 "missing thought_signature" (#2504).
  const signatureNamespace = credentials && typeof credentials["_signatureNamespace"] === "string" ? credentials["_signatureNamespace"] : null;
  return openaiToGeminiBase(model, body, stream, {
    signatureNamespace,
    signaturelessToolCallMode: options.signaturelessToolCallMode,
    stripFunctionCallId: isVertexGeminiProvider(credentials?._provider)
  });
}

// OpenAI -> Cloud Code Gemini payload used by Antigravity.
export function openaiToCloudCodeGeminiRequest(model, body, stream, options = {}) {
  return openaiToGeminiBase(model, body, stream, {
    stripNamespace: true,
    signatureNamespace: options.signatureNamespace,
    signaturelessToolCallMode: options.signaturelessToolCallMode,
    supportsSignatureBypass: true
  });
}
function wrapInCloudCodeEnvelope(model, cloudCodeRequest, credentials = null) {
  // Fall back to providerSpecificData.projectId — some connections (and post-refresh
  // credentials) store it there rather than at the top level, which otherwise produced a
  // spurious 422 "Missing Google projectId" on the Antigravity /v1beta path (#2480).
  const providerSpecificProjectId = credentials?.providerSpecificData?.projectId;
  let projectId = credentials?.projectId || (typeof providerSpecificProjectId === "string" ? providerSpecificProjectId : "");
  if (!projectId) {
    console.warn(`[OmniRoute] Antigravity account is missing projectId. ` + `Attempting request with empty project — reconnect OAuth to resolve.`);
    projectId = "";
  }
  const cleanModel = model.includes("/") ? model.split("/").pop() : model;
  const envelope = {
    project: projectId,
    requestId: generateAntigravityRequestId(),
    request: {
      sessionId: getAntigravitySessionId(credentials),
      contents: cloudCodeRequest.contents,
      systemInstruction: cloudCodeRequest.systemInstruction,
      generationConfig: applyAntigravityGenerationDefaults(cloudCodeRequest.generationConfig),
      tools: cloudCodeRequest.tools
    },
    model: cleanModel,
    userAgent: getAntigravityEnvelopeUserAgent(credentials),
    requestType: "agent",
    enabledCreditTypes: ["GOOGLE_ONE_AI"]
  };
  if (cloudCodeRequest._toolNameMap instanceof Map && cloudCodeRequest._toolNameMap.size > 0) {
    envelope._toolNameMap = cloudCodeRequest._toolNameMap;
  }
  const defaultPart = {
    text: ANTIGRAVITY_DEFAULT_SYSTEM
  };
  if (envelope.request.systemInstruction?.parts) {
    envelope.request.systemInstruction.parts.unshift(defaultPart);
  } else {
    envelope.request.systemInstruction = {
      role: "system",
      parts: [defaultPart]
    };
  }

  // Strip Gemini built-in tool *names* out of functionDeclarations: Antigravity's
  // v1internal endpoint returns 400 when a built-in tool (google_search etc.) is
  // mixed with functionDeclarations in the same request. Native grounding entries
  // (e.g. `{ googleSearch: {} }`) are left intact; only the functionDeclarations
  // arrays are cleaned, and a declarations entry that becomes empty is dropped.
  if (envelope.request.tools && envelope.request.tools.length > 0) {
    const cleanedTools = envelope.request.tools.map(tool => {
      if (!Array.isArray(tool.functionDeclarations)) {
        return tool;
      }
      const customDecls = tool.functionDeclarations.filter(fn => !GEMINI_BUILTIN_TOOL_NAMES.has(fn.name));
      return {
        ...tool,
        functionDeclarations: customDecls
      };
    }).filter(tool => !Array.isArray(tool.functionDeclarations) || tool.functionDeclarations.length > 0);
    envelope.request.tools = cleanedTools.length > 0 ? cleanedTools : undefined;
  }
  const hasCustomTools = envelope.request.tools?.some(tool => (tool.functionDeclarations?.length ?? 0) > 0);
  if (hasCustomTools) {
    envelope.request.toolConfig = {
      functionCallingConfig: {
        mode: "VALIDATED"
      }
    };
  }
  return envelope;
}
function getAntigravityClaudeOutputTokens(body) {
  const requested = body.max_tokens ?? body.max_completion_tokens;
  if (typeof requested === "number" && Number.isFinite(requested) && requested >= 1) {
    return Math.min(Math.floor(requested), ANTIGRAVITY_CLAUDE_MAX_OUTPUT_TOKENS);
  }
  return ANTIGRAVITY_CLAUDE_MAX_OUTPUT_TOKENS;
}

// OpenAI -> Antigravity (Sandbox Cloud Code with wrapper)
export function openaiToAntigravityRequest(model, body, stream, credentials = null) {
  const isClaude = model.toLowerCase().includes("claude");
  // All modern Gemini models (2.5+, 3.x, pro-agent, etc.) use thinking by default
  // and require thought_signature for multi-turn tool calls.
  // Safe default: all non-Claude models via Antigravity are thinking Gemini.
  const modelLower = model.toLowerCase();
  const isThinkingGemini = !isClaude && (modelLower.includes("thinking") || modelLower.includes("gemini-3") || modelLower.includes("gemini-2.5") || modelLower.includes("gemini-pro"));
  const signatureNamespace = credentials && typeof credentials === "object" && typeof credentials._signatureNamespace === "string" ? credentials._signatureNamespace : null;
  const cloudCodeRequest = openaiToCloudCodeGeminiRequest(model, body, stream, {
    signatureNamespace,
    signaturelessToolCallMode: isThinkingGemini ? "context" : "native"
  });
  if (isClaude) {
    cloudCodeRequest.generationConfig.maxOutputTokens = getAntigravityClaudeOutputTokens(body);
  }
  const envelope = wrapInCloudCodeEnvelope(model, cloudCodeRequest, credentials);

  // Match real Antigravity client: don't send maxOutputTokens when the user
  // hasn't explicitly specified max_tokens / max_completion_tokens.
  // The Cloud Code server decides the output limit on its own.
  // Note: read hasThinking BEFORE stripping thinkingConfig below — for Claude
  // models the Cloud Code envelope still carries a thinkingBudget set upstream
  // by applyAntigravityGenerationDefaults, which we must consult here so we
  // do not accidentally drop the maxOutputTokens it bumped for us.
  const clientRequestedMaxTokens = body.max_tokens ?? body.max_completion_tokens;
  const hasThinking = !!envelope.request?.generationConfig?.thinkingConfig?.thinkingBudget;
  if (clientRequestedMaxTokens === undefined && !hasThinking && envelope.request?.generationConfig) {
    delete envelope.request.generationConfig.maxOutputTokens;
  }

  // Claude models on Antigravity use their own native thinking — Gemini's thinkingConfig
  // is not understood by the Cloud Code Claude endpoint and must be stripped.
  // applyAntigravityGenerationDefaults (inside wrapInCloudCodeEnvelope) already bumped
  // maxOutputTokens to thinkingBudget+1 before we get here, so the budget is preserved.
  // Must run AFTER the hasThinking-derived maxOutputTokens decision above so the
  // budget is accounted for before the field is removed.
  if (isClaude && envelope.request?.generationConfig) {
    delete envelope.request.generationConfig.thinkingConfig;
  }
  return envelope;
}

// Register
register(FORMATS.OPENAI, FORMATS.GEMINI, (model, body, stream = false, credentials = null) => openaiToGeminiRequest(model, body, stream, credentials, {
  signaturelessToolCallMode: "context"
}), null);
register(FORMATS.OPENAI, FORMATS.ANTIGRAVITY, openaiToAntigravityRequest, null);