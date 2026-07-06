import { getCodexModelScope } from "../../config/codexQuotaScopes";
import { getProviderConnectionById, updateProviderConnection } from "../../stubs/lib/db/providers";
function asProviderData(value) {
  return value && typeof value === "object" ? value : {};
}
export async function markCodexScopeRateLimited(params) {
  const connection = await getProviderConnectionById(params.failedConnectionId).catch(() => null);
  const existingProviderData = connection ? asProviderData(connection.providerSpecificData) : asProviderData(params.credentials?.providerSpecificData);
  const existingScopeMap = asProviderData(existingProviderData.codexScopeRateLimitedUntil);
  const nextProviderData = {
    ...existingProviderData,
    codexScopeRateLimitedUntil: {
      ...existingScopeMap,
      [getCodexModelScope(params.model || "")]: params.rateLimitedUntil
    }
  };
  updateProviderConnection(params.failedConnectionId, {
    ...(connection ? {
      providerSpecificData: nextProviderData
    } : {}),
    lastError: "429 rate limited — codex account rotation",
    errorCode: 429
  }).catch(() => {});
  if (params.credentials && String(params.credentials.connectionId) === params.failedConnectionId) {
    params.credentials.providerSpecificData = nextProviderData;
  }
}