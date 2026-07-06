import { buildAntigravityUrl, ANTIGRAVITY_BASE_URLS, ANTIGRAVITY_PUBLIC_MODELS, getAntigravityProviderHeaders, resolvePublicCred } from "../../shared";
export const antigravityProvider = {
  id: "antigravity",
  alias: undefined,
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
  models: [...ANTIGRAVITY_PUBLIC_MODELS],
  passthroughModels: true
};