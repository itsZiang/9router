import { BaseExecutor } from "./base";
import { PROVIDERS } from "../config/constants";
import { DEFAULT_POOL_CONFIG } from "../services/sessionPool/types";
export class PollinationsExecutor extends BaseExecutor {
  constructor() {
    super("pollinations", PROVIDERS["pollinations"] || {
      format: "openai"
    });
    this.poolConfig = DEFAULT_POOL_CONFIG;
  }
  buildUrl(_model, _stream, urlIndex = 0, _credentials = null) {
    const baseUrls = this.getBaseUrls();
    return baseUrls[urlIndex] || baseUrls[0] || "https://gen.pollinations.ai/v1/chat/completions";
  }
  buildHeaders(credentials, stream = true) {
    const key = credentials?.apiKey || credentials?.accessToken;
    const headers = {
      "Content-Type": "application/json"
    };
    if (key) {
      headers.Authorization = `Bearer ${key}`;
    }
    if (stream) {
      headers["Accept"] = "text/event-stream";
    }
    return headers;
  }
  transformRequest(model, body, stream, _credentials) {
    if (typeof body === "object" && body !== null) {
      body.model = model;
      body.stream = stream;
      // #3981: Pollinations treats jsonMode=true as "the model MUST return JSON"
      // and rejects (HTTP 400) any request whose messages don't mention "json".
      // Only enable it when the caller actually asked for JSON output.
      const responseFormatType = body.response_format?.type;
      if (responseFormatType === "json_object" || responseFormatType === "json_schema") {
        body.jsonMode = true;
      }
    }
    return body;
  }
  async execute(input) {
    const isAnonymous = !input.credentials?.apiKey && !input.credentials?.accessToken;
    if (!isAnonymous) {
      return super.execute(input);
    }
    const pool = this.getPool();

    // Use acquireBlocking for anonymous requests to wait for available session
    let session;
    try {
      session = pool ? await pool.acquireBlocking(10_000) : null;
    } catch {
      // Pool exhausted — fall through to direct request without fingerprint
      session = null;
    }
    if (session) {
      const fpHeaders = session.buildHeaders();
      input.upstreamExtraHeaders = {
        ...fpHeaders,
        ...input.upstreamExtraHeaders
      };
    }
    try {
      const result = await super.execute(input);
      if (session && pool) {
        const status = result.response.status;
        if (status === 429) {
          pool.reportCooldown(session);
        } else if (status >= 500) {
          pool.reportDead(session);
        } else {
          pool.reportSuccess(session);
        }
      }
      return result;
    } catch (err) {
      if (session && pool) {
        pool.reportCooldown(session);
      }
      // Enhance 401 errors with actionable guidance
      if (err?.status === 401 || err?.statusCode === 401) {
        const premiumModels = ["claude", "claude-fast", "claude-large", "gemini", "gemini-fast", "midijourney", "midijourney-large"];
        const model = input.model || "";
        if (premiumModels.includes(model)) {
          const enhanced = new Error(`Pollinations model "${model}" requires an API key. ` + `Free keyless models: openai, openai-fast, openai-large, qwen-coder, mistral, deepseek, grok, gemini-flash-lite-3.1, perplexity-fast, perplexity-reasoning. ` + `Get a Pollinations API key at https://enter.pollinations.ai and add it in Settings → API Keys.`);
          enhanced.status = 401;
          enhanced.type = "authentication_error";
          throw enhanced;
        }
      }
      throw err;
    } finally {
      session?.release();
    }
  }
}
export default PollinationsExecutor;