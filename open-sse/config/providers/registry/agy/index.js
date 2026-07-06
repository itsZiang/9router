import { buildAntigravityUrl, ANTIGRAVITY_BASE_URLS, AGY_PUBLIC_MODELS, getAntigravityProviderHeaders, resolvePublicCred } from "../../shared";
export const agyProvider = {
  id: "agy",
  alias: "agy",
  format: "antigravity",
  executor: "antigravity",
  baseUrls: [...ANTIGRAVITY_BASE_URLS],
  urlBuilder: buildAntigravityUrl,
  authType: "oauth",
  authHeader: "bearer",
  headers: getAntigravityProviderHeaders(),
  oauth: {
    clientIdEnv: "ANTIGRAVITY_OAUTH_CLIENT_ID",
    clientIdDefault: resolvePublicCred("antigravity_id"),
    clientSecretEnv: "ANTIGRAVITY_OAUTH_CLIENT_SECRET",
    clientSecretDefault: resolvePublicCred("antigravity_alt")
  },
  models: [...AGY_PUBLIC_MODELS],
  passthroughModels: true
};