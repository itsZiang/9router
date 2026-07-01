// Default provider config for OpenAI-compatible and Anthropic-compatible upstreams.
// Encapsulates the header/auth/url/request logic that historically lived in DefaultExecutor.

import { BaseProviderConfig } from "./BaseProviderConfig.js";
import { OpenAIResponseIterator } from "../streaming/OpenAIResponseIterator.js";
import { PROVIDERS } from "../config/providers.js";
import { ANTHROPIC_API_VERSION, OPENAI_COMPAT_BASE, ANTHROPIC_COMPAT_BASE } from "./shared.js";
import { OAUTH_ENDPOINTS, buildKimiHeaders } from "../config/appConstants.js";
import { buildClineHeaders } from "../shared/clineAuth.js";
import { getCachedClaudeHeaders } from "../utils/claudeHeaderCache.js";
import { stripUnsupportedParams } from "../translator/concerns/paramSupport.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";

// Auth descriptors — derived from registry transport.auth, fallback to hardcoded defaults.
const BEARER = { combined: true, header: "Authorization", scheme: "bearer" };
const XAPIKEY = { combined: true, header: "x-api-key", scheme: "raw" };
const AUTH_DESCRIPTORS = Object.fromEntries(
  Object.entries(PROVIDERS)
    .filter(([, t]) => t.auth)
    .map(([id, t]) => [id, t.auth])
);

// Apply a token to a header per scheme (matches legacy: combined always sets, even when undefined).
function setAuth(headers, spec, token) {
  headers[spec.header] = spec.scheme === "bearer" ? `Bearer ${token}` : token;
}

// Resolve auth onto headers from a descriptor.
function applyAuth(headers, desc, credentials) {
  if (desc.combined) {
    setAuth(headers, desc, credentials.apiKey || credentials.accessToken);
    if (desc.anthropicVersion && !headers["anthropic-version"]) {
      headers["anthropic-version"] = ANTHROPIC_API_VERSION;
    }
    return;
  }
  if (credentials.apiKey) setAuth(headers, desc.apiKey, credentials.apiKey);
  else if (credentials.accessToken) setAuth(headers, desc.oauth, credentials.accessToken);
  if (desc.anthropicVersion && !headers["anthropic-version"]) {
    headers["anthropic-version"] = ANTHROPIC_API_VERSION;
  }
}

// Provider-specific header quirks kept as small hooks (not pure auth).
const HEADER_HOOKS = {
  kimiHeaders: (h) => Object.assign(h, buildKimiHeaders()),
  clineHeaders: (h, c) => Object.assign(h, buildClineHeaders(c.apiKey || c.accessToken)),
  kilocodeOrg: (h, c) => {
    if (c.providerSpecificData?.orgId) h["X-Kilocode-OrganizationID"] = c.providerSpecificData.orgId;
  },
  claudeOverlay: (h) => {
    const cached = getCachedClaudeHeaders();
    if (!cached) return;
    for (const lcKey of Object.keys(cached)) {
      const titleKey = lcKey.replace(/(^|-)([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
      if (lcKey === "anthropic-beta") {
        const staticBetaStr = h[titleKey] || h[lcKey] || "";
        const flags = new Set(staticBetaStr.split(",").map(f => f.trim()).filter(Boolean));
        for (const f of cached[lcKey].split(",").map(f => f.trim()).filter(Boolean)) flags.add(f);
        cached[lcKey] = Array.from(flags).join(",");
      }
      if (titleKey !== lcKey && h[titleKey] !== undefined) delete h[titleKey];
    }
    Object.assign(h, cached);
  },
};

export class DefaultProviderConfig extends BaseProviderConfig {
  constructor(provider, config) {
    super(provider, config);
  }

  getBaseUrls() {
    return this.config.baseUrls || (this.config.baseUrl ? [this.config.baseUrl] : []);
  }

  validateEnvironment({ apiKey, apiBase, headers, model, messages, optionalParams }) {
    if (this.provider?.startsWith?.("openai-compatible-") && !apiBase && !this.config.baseUrl) {
      return { ok: false, message: "apiBase required for openai-compatible provider" };
    }
    if (this.provider?.startsWith?.("anthropic-compatible-") && !apiBase && !this.config.baseUrl) {
      return { ok: false, message: "apiBase required for anthropic-compatible provider" };
    }
    return { ok: true };
  }

  buildUrl({ apiBase, apiKey, model, optionalParams, stream, credentials, urlIndex = 0, baseUrls = this.getBaseUrls() }) {
    // Runtime transport (multi-endpoint providers): use the sourceFormat-matched endpoint
    const rt = credentials?.runtimeTransport;
    if (rt?.baseUrl) {
      return rt.urlSuffix ? `${rt.baseUrl}${rt.urlSuffix}` : rt.baseUrl;
    }

    if (this.provider?.startsWith?.("openai-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || apiBase || this.config.baseUrl || OPENAI_COMPAT_BASE;
      const normalized = baseUrl.replace(/\/$/, "");
      const path = this.provider.includes("responses") ? "/responses" : "/chat/completions";
      return `${normalized}${path}`;
    }

    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || apiBase || this.config.baseUrl || ANTHROPIC_COMPAT_BASE;
      const normalized = baseUrl.replace(/\/$/, "");
      return `${normalized}/messages`;
    }

    // gemini-format: build :streamGenerateContent / :generateContent path
    if (this.config.format === "gemini") {
      return `${this.config.baseUrl}/${model}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
    }

    if (this.config.urlSuffix) {
      return `${this.config.baseUrl}${this.config.urlSuffix}`;
    }

    const url = baseUrls[urlIndex] || baseUrls[0] || this.config.baseUrl;
    if (url?.includes("{accountId}")) {
      const accountId = credentials?.providerSpecificData?.accountId;
      if (!accountId) throw new Error(`${this.provider} requires accountId in providerSpecificData`);
      return url.replace("{accountId}", accountId);
    }
    return url;
  }

  // Fallback descriptor for providers without an explicit entry in AUTH_DESCRIPTORS.
  resolveAuthDescriptor() {
    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      return {
        apiKey: { header: "x-api-key", scheme: "raw" },
        oauth: { header: "Authorization", scheme: "bearer" },
        anthropicVersion: true
      };
    }
    if (this.config?.format === "claude") {
      return { ...XAPIKEY, anthropicVersion: true };
    }
    return BEARER;
  }

  buildHeaders({ credentials, stream, requestData }) {
    const rt = credentials?.runtimeTransport;
    const headers = { "Content-Type": "application/json", ...(rt ? rt.headers : this.config.headers) };
    const desc = rt?.auth || AUTH_DESCRIPTORS[this.provider] || this.resolveAuthDescriptor();

    // Hooks run BEFORE auth so dynamic overlays (claude cached headers) can't clobber the token.
    for (const hook of desc.hooks || []) HEADER_HOOKS[hook]?.(headers, credentials);
    applyAuth(headers, desc, credentials);

    // Strip first-party Claude Code identity headers for non-Anthropic anthropic-compatible upstreams
    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || "";
      const isOfficialAnthropic = baseUrl === "" || baseUrl.includes("api.anthropic.com");
      if (!isOfficialAnthropic) {
        if (credentials.apiKey && !headers["Authorization"]) {
          headers["Authorization"] = `Bearer ${credentials.apiKey}`;
        }
        delete headers["anthropic-dangerous-direct-browser-access"];
        delete headers["Anthropic-Dangerous-Direct-Browser-Access"];
        delete headers["x-app"];
        delete headers["X-App"];
        for (const betaKey of ["anthropic-beta", "Anthropic-Beta"]) {
          if (headers[betaKey]) {
            const filtered = headers[betaKey]
              .split(",")
              .map(s => s.trim())
              .filter(f => f && f !== "claude-code-20250219")
              .join(",");
            if (filtered) headers[betaKey] = filtered;
            else delete headers[betaKey];
          }
        }
      }
    }

    if (stream) headers["Accept"] = "text/event-stream";
    return headers;
  }

  transformRequest({ model, messages, optionalParams, stream, credentials, body }) {
    let transformed = this.applyJsonSchemaFallback(body);

    if (transformed && typeof transformed === "object") {
      if (this.config.quirks?.dropClientMetadata) {
        delete transformed.client_metadata;
      }
      stripUnsupportedParams(this.provider, model, transformed);
    }

    return injectReasoningContent({ provider: this.provider, model, body: transformed });
  }

  // Fallback json_schema → json_object for openai-compatible providers without native Structured Output.
  applyJsonSchemaFallback(body) {
    if (!this.provider?.startsWith?.("openai-compatible-")) return body;
    const rf = body?.response_format;
    if (rf?.type !== "json_schema" || !rf.json_schema?.schema) return body;

    const schemaJson = JSON.stringify(rf.json_schema.schema, null, 2);
    const prompt = `You must respond with valid JSON that strictly follows this JSON schema:\n\`\`\`json\n${schemaJson}\n\`\`\`\nRespond ONLY with the JSON object, no other text.`;

    const messages = Array.isArray(body.messages) ? body.messages.map(m => ({ ...m })) : [];
    const sys = messages.find(m => m.role === "system");
    if (sys) {
      if (typeof sys.content === "string") sys.content = `${sys.content}\n\n${prompt}`;
      else if (Array.isArray(sys.content)) sys.content.push({ type: "text", text: `\n\n${prompt}` });
    } else {
      messages.unshift({ role: "system", content: prompt });
    }
    return { ...body, messages, response_format: { type: "json_object" } };
  }

  getResponseIterator({ rawResponse, model, stream }) {
    if (this.provider?.startsWith?.("openai-compatible-") || this.config.format === "openai") {
      return new OpenAIResponseIterator({ model, provider: this.provider });
    }
    return null;
  }

  parseError({ response, bodyText }) {
    let message = "";
    try {
      const json = JSON.parse(bodyText);
      message = json.error?.message || json.message || json.error || bodyText;
    } catch {
      message = bodyText;
    }
    const messageStr = typeof message === "string" ? message : JSON.stringify(message);
    return {
      status: response?.status,
      message: messageStr || `HTTP ${response?.status}`
    };
  }
}

export default DefaultProviderConfig;
