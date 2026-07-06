const FALLBACK_KIE_CALLBACK_URL = "https://omniroute.local/api/kie/callback";
export function isJsonObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function callbackUrlFromBaseUrl(baseUrl) {
  if (!baseUrl || baseUrl.trim().length === 0) return null;
  try {
    const url = new URL(baseUrl);
    url.pathname = "/api/kie/callback";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}
function getConfiguredKieCallbackUrl() {
  const explicit = process.env.KIE_CALLBACK_URL?.trim() || process.env.OMNIROUTE_KIE_CALLBACK_URL?.trim();
  if (explicit) return explicit;
  return callbackUrlFromBaseUrl(process.env.OMNIROUTE_PUBLIC_URL) || callbackUrlFromBaseUrl(process.env.NEXT_PUBLIC_APP_URL) || callbackUrlFromBaseUrl(process.env.APP_URL) || callbackUrlFromBaseUrl(process.env.PUBLIC_URL) || FALLBACK_KIE_CALLBACK_URL;
}
export function getKieCallbackUrl(body = {}) {
  const callbackUrl = body.callBackUrl ?? body.callback_url ?? body.callbackUrl;
  return typeof callbackUrl === "string" && callbackUrl.trim().length > 0 ? callbackUrl : getConfiguredKieCallbackUrl();
}
export function parseKieResultJson(recordData) {
  const data = isJsonObject(recordData) && isJsonObject(recordData.data) ? recordData.data : {};
  const resultJson = data.resultJson;
  if (typeof resultJson === "string") {
    try {
      const parsed = JSON.parse(resultJson);
      return isJsonObject(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isJsonObject(resultJson) ? resultJson : {};
}
export function normalizeKieTaskState(recordData) {
  const record = isJsonObject(recordData) ? recordData : {};
  const data = isJsonObject(record.data) ? record.data : {};
  const state = String(data.status ?? data.state ?? data.successFlag ?? record.msg ?? "PENDING").toUpperCase();
  if (state === "SUCCESS" || state === "1" || state === "FINISHED" || state === "COMPLETE" || state === "COMPLETED" || state === "FIRST_SUCCESS" || state === "ALL_SUCCESS" || state.includes("SUCCESS")) {
    return "success";
  }
  if (state === "FAIL" || state === "FAILED" || state === "ERROR" || state === "2" || state === "3" || state.includes("FAIL") || state.includes("ERROR") || state === "CREATE_TASK_FAILED" || state === "GENERATE_FAILED" || state === "GENERATE_AUDIO_FAILED") {
    return "failed";
  }
  return "pending";
}
export function getKieErrorStatus(error, fallback = 502) {
  if (isJsonObject(error)) {
    const status = Number(error.status);
    if (Number.isFinite(status) && status > 0) {
      return status;
    }
  }
  return fallback;
}
export function getKieErrorMessage(error, fallback) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (isJsonObject(error) && typeof error.message === "string" && error.message.length > 0) {
    return error.message;
  }
  return typeof error === "string" && error.length > 0 ? error : fallback;
}