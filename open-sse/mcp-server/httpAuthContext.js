import { AsyncLocalStorage } from "node:async_hooks";
const mcpHttpAuthContext = new AsyncLocalStorage();
function headerValue(request, name) {
  const value = request.headers.get(name);
  return value && value.trim().length > 0 ? value : undefined;
}
export function getMcpHttpAuthHeadersForInternalFetch() {
  const context = mcpHttpAuthContext.getStore();
  const headers = {};
  if (context?.authorization) headers.Authorization = context.authorization;
  if (context?.cookie) headers.Cookie = context.cookie;
  if (context?.xApiKey && context?.anthropicVersion) {
    headers["x-api-key"] = context.xApiKey;
    headers["anthropic-version"] = context.anthropicVersion;
  }
  return headers;
}
export async function withMcpHttpAuthContext(request, callback) {
  return mcpHttpAuthContext.run({
    authorization: headerValue(request, "authorization"),
    cookie: headerValue(request, "cookie"),
    xApiKey: headerValue(request, "x-api-key"),
    anthropicVersion: headerValue(request, "anthropic-version")
  }, callback);
}