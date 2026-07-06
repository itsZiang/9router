export const GITLAB_DUO_DEFAULT_BASE_URL = null;

export function buildGitLabDirectGatewayUrl() {
  return undefined;
}

export function buildGitLabOAuthEndpoints(baseUrl) {
  // Return minimal object shape so callers don't crash on .publicCompletionsUrl etc.
  return {
    publicCompletionsUrl: null,
    authorizeUrl: null,
    tokenUrl: null,
    revokeUrl: null,
    userInfoUrl: null,
  };
}

export function getCachedGitLabDirectAccess() {
  return null;
}

export function isGitLabDirectAccessDisabled() {
  return false;
}

export function parseGitLabDirectAccessDetails() {
  return undefined;
}

export function resolveGitLabOAuthBaseUrl() {
  return undefined;
}

const _defaultExport = {};
export default _defaultExport;
