/**
 * chatCore per-attempt logging persistence (Quality Gate v2 / Fase 9 — chatCore god-file
 * decomposition, #3501).
 *
 * Extracted from handleChatCore: persists one attempt's call log. Emits a provider.warning audit
 * event when the provider response carries warnings, fills the detailed pipeline payloads (when
 * detailed logging is on), and writes the bounded/truncated call-log row (request/response bodies
 * with the Claude prompt-cache meta attached). Best-effort: the saveCallLog write swallows its own
 * errors. The per-request context (provider/model/ids/combo/etc.) is threaded via `ctx` so the 16
 * call sites in the handler stay byte-identical; behaviour is unchanged.
 */

import { extractProviderWarnings } from "../../stubs/lib/compliance/providerAudit";
import { logAuditEvent } from "../../stubs/lib/compliance";
import { saveCallLog } from "@/lib/usageDb";
import { cloneBoundedChatLogPayload, truncateForLog } from "./logTruncation";
import { attachLogMeta } from "./cacheUsageMeta";
function toConnectionId(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
function buildAccountRotationMeta(provider, initialConnectionId, finalConnectionId) {
  if (provider !== "codex" || !initialConnectionId || !finalConnectionId) return null;
  if (initialConnectionId === finalConnectionId) return null;
  return {
    codexAccountRotation: {
      initialConnectionId,
      finalConnectionId
    }
  };
}
export function persistAttemptLogs(args, ctx) {
  const {
    status,
    tokens,
    responseBody,
    error,
    providerRequest,
    providerResponse,
    clientResponse,
    claudeCacheMeta,
    claudeCacheUsageMeta,
    cacheSource
  } = args;
  const {
    provider,
    connectionId,
    model,
    skillRequestId,
    detailedLoggingEnabled,
    reqLogger,
    pendingRequestId,
    clientRawRequest,
    requestedModel,
    credentials,
    startTime,
    body,
    sourceFormat,
    targetFormat,
    comboName,
    comboStepId,
    comboExecutionKey,
    tokensCompressed,
    apiKeyInfo,
    noLogEnabled,
    correlationId
  } = ctx;
  const initialConnectionId = toConnectionId(connectionId);
  const finalConnectionId = toConnectionId(credentials?.connectionId) || initialConnectionId;
  const accountRotationMeta = buildAccountRotationMeta(provider, initialConnectionId, finalConnectionId);
  const providerWarnings = extractProviderWarnings(providerResponse, clientResponse, responseBody);
  if (providerWarnings.length > 0) {
    logAuditEvent({
      action: "provider.warning",
      actor: "system",
      target: [provider, finalConnectionId].filter(Boolean).join(":") || provider || model,
      resourceType: "provider_warning",
      status: "warning",
      requestId: skillRequestId,
      details: {
        provider,
        model,
        connectionId: finalConnectionId,
        httpStatus: status,
        warnings: providerWarnings
      }
    });
  }
  const pipelinePayloads = detailedLoggingEnabled ? reqLogger?.getPipelinePayloads?.() ?? {} : null;
  if (pipelinePayloads) {
    if (providerRequest !== undefined && !pipelinePayloads.providerRequest) {
      pipelinePayloads.providerRequest = providerRequest;
    }
    if (providerResponse !== undefined && !pipelinePayloads.providerResponse) {
      pipelinePayloads.providerResponse = providerResponse;
    }
    if (clientResponse !== undefined) {
      pipelinePayloads.clientResponse = clientResponse;
    }
    if (error) {
      pipelinePayloads.error = {
        ...(typeof pipelinePayloads.error === "object" && pipelinePayloads.error ? pipelinePayloads.error : {}),
        message: error
      };
    }
  }
  saveCallLog({
    id: pendingRequestId,
    method: "POST",
    path: clientRawRequest?.endpoint || "/v1/chat/completions",
    status,
    model,
    requestedModel,
    provider,
    connectionId: finalConnectionId || undefined,
    duration: Date.now() - startTime,
    tokens: tokens || {},
    requestBody: cloneBoundedChatLogPayload(attachLogMeta(truncateForLog(body), {
      ...accountRotationMeta,
      claudePromptCache: claudeCacheMeta
    })),
    responseBody: cloneBoundedChatLogPayload(attachLogMeta(truncateForLog(responseBody), {
      ...accountRotationMeta,
      claudePromptCache: claudeCacheMeta ? {
        applied: claudeCacheMeta.applied,
        totalBreakpoints: claudeCacheMeta.totalBreakpoints,
        anthropicBeta: claudeCacheMeta.anthropicBeta
      } : null,
      claudePromptCacheUsage: claudeCacheUsageMeta
    })),
    error: error || null,
    sourceFormat,
    targetFormat,
    comboName,
    comboStepId,
    comboExecutionKey,
    tokensCompressed,
    cacheSource: cacheSource === "semantic" ? "semantic" : "upstream",
    apiKeyId: apiKeyInfo?.id || null,
    apiKeyName: apiKeyInfo?.name || null,
    noLog: noLogEnabled,
    pipelinePayloads,
    correlationId
  }).catch(() => {});
}