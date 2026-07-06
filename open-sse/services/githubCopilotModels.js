/**
 * GitHub Copilot live model discovery (#3120, #3121).
 *
 * The `github` (Copilot) provider previously shipped a STATIC hardcoded model
 * catalog in `providerRegistry.ts` and had no discovery source, so "Import
 * Models" could never refresh the list (#3120) and advertised models the
 * account is not entitled to (e.g. gemini previews), which fail upstream with
 * `400 ... not supported` when tested (#3121).
 *
 * Copilot exposes its per-account catalog at `https://api.githubcopilot.com/models`,
 * authenticated with the Copilot bearer token + the standard Copilot chat
 * headers. The response shape is `{ data: [{ id, name, model_picker_enabled,
 * policy, capabilities, ... }] }`. We map `data[].id` into managed models. Only
 * entitled models appear in the live response, so parsing it directly gives the
 * entitlement filtering #3121 needs.
 *
 * A safe fallback to the existing static catalog is preserved for
 * offline/unauthed/failed refresh so the import flow never breaks.
 */
import { getGitHubCopilotChatHeaders } from "../config/providerHeaderProfiles";
export const GITHUB_COPILOT_MODELS_URL = "https://api.githubcopilot.com/models";
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function toNonEmptyString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Parse a Copilot `/models` response into managed model rows. Only ids present
 * in the live response are returned, which is exactly the entitlement filter
 * #3121 requires.
 */
export function parseGitHubCopilotModels(data) {
  const payload = asRecord(data);
  const items = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : [];
  const seen = new Set();
  const models = [];
  for (const value of items) {
    const item = asRecord(value);
    const id = toNonEmptyString(item.id) || toNonEmptyString(item.model);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = toNonEmptyString(item.name) || toNonEmptyString(item.display_name) || id;
    models.push({
      id,
      name,
      owned_by: "github"
    });
  }
  return models;
}
function toFallbackResult(fallbackModels) {
  const models = (fallbackModels || []).map(model => {
    const id = toNonEmptyString(model.id);
    if (!id) return null;
    return {
      id,
      name: toNonEmptyString(model.name) || id,
      owned_by: "github"
    };
  }).filter(model => Boolean(model));
  return {
    models,
    source: "fallback"
  };
}

/**
 * Discover the Copilot model catalog live, falling back to the static catalog
 * when no token is available or the upstream request fails.
 */
export async function fetchGitHubCopilotModels(options) {
  const {
    token,
    fetchImpl = fetch,
    fallbackModels
  } = options;
  if (!toNonEmptyString(token)) {
    return toFallbackResult(fallbackModels);
  }
  try {
    const response = await fetchImpl(GITHUB_COPILOT_MODELS_URL, {
      method: "GET",
      headers: {
        ...getGitHubCopilotChatHeaders("application/json"),
        Authorization: `Bearer ${token}`
      }
    });
    if (!response.ok) {
      return toFallbackResult(fallbackModels);
    }
    const data = await response.json();
    const models = parseGitHubCopilotModels(data);
    if (models.length === 0) {
      return toFallbackResult(fallbackModels);
    }
    return {
      models,
      source: "api"
    };
  } catch {
    // Network/parse failure — never break the import flow.
    return toFallbackResult(fallbackModels);
  }
}