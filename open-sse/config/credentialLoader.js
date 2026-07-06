/**
 * Credential Loader — Reads provider credentials from an external JSON file.
 *
 * Loads `provider-credentials.json` from the data directory and merges it
 * over the hardcoded defaults in PROVIDERS. This keeps credentials out of
 * source control while maintaining backwards compatibility (hardcoded values
 * serve as defaults when the file is absent).
 *
 * Expected JSON structure:
 * {
 *   "claude": { "clientId": "..." },
 *   "gemini": { "clientId": "...", "clientSecret": "..." },
 *   ...
 * }
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";

// Fields that can be overridden per provider
const CREDENTIAL_FIELDS = ["clientId", "clientSecret", "tokenUrl", "authUrl", "refreshUrl"];
// TTL-based cache — reloads credentials from disk at most once per minute
const CONFIG_TTL_MS = 60_000;
let lastLoadTime = 0;
let cachedProviders = null;

// Survives Next.js dev HMR: module-level cache resets but process is the same (V4 pattern).

function credGlobals() {
  return globalThis;
}
function resolveCredentialsPath() {
  let resolveDataDir;
  try {
    resolveDataDir = require("../stubs/lib/dataPaths").resolveDataDir;
  } catch (err) {
    const fallbackDataDir = process.env.DATA_DIR || join(process.cwd(), "data");
    console.warn(`[CREDENTIALS] Could not load dataPaths module, using fallback: ${fallbackDataDir}`);
    return join(fallbackDataDir, "provider-credentials.json");
  }
  return join(resolveDataDir(), "provider-credentials.json");
}
export function loadProviderCredentials(providers) {
  if (cachedProviders && Date.now() - lastLoadTime < CONFIG_TTL_MS) {
    return cachedProviders;
  }
  const credPath = resolveCredentialsPath();
  if (!existsSync(credPath)) {
    if (!credGlobals().__omnirouteCredNoFileLogged) {
      console.log("[CREDENTIALS] No external credentials file found, using defaults.");
      credGlobals().__omnirouteCredNoFileLogged = true;
    }
    cachedProviders = providers;
    lastLoadTime = Date.now();
    return providers;
  }
  try {
    const raw = readFileSync(credPath, "utf-8");
    const external = JSON.parse(raw);
    let overrideCount = 0;
    const mutableProviders = providers;
    for (const [providerKey, creds] of Object.entries(external)) {
      if (!mutableProviders[providerKey]) {
        console.log(`[CREDENTIALS] Warning: unknown provider "${providerKey}" in credentials file, skipping.`);
        continue;
      }
      if (!creds || typeof creds !== "object") {
        console.log(`[CREDENTIALS] Warning: provider "${providerKey}" value must be an object, got ${typeof creds}. Skipping.`);
        continue;
      }
      const credentialOverrides = creds;
      for (const field of CREDENTIAL_FIELDS) {
        if (credentialOverrides[field] !== undefined) {
          mutableProviders[providerKey][field] = credentialOverrides[field];
          overrideCount++;
        }
      }
    }
    const isReload = cachedProviders !== null;
    console.log(`[CREDENTIALS] ${isReload ? "Reloaded" : "Loaded"} external credentials: ${overrideCount} field(s) from ${credPath}`);
  } catch (err) {
    const reason = err instanceof SyntaxError ? "Invalid JSON format" : err.code || "read error";
    console.log(`[CREDENTIALS] Error reading credentials file (${reason}). Using defaults.`);
  }
  cachedProviders = providers;
  lastLoadTime = Date.now();
  return providers;
}