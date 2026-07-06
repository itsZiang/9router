import { BaseExecutor } from "./base";
import { PROVIDERS } from "../config/constants";
/**
 * CloudflareAIExecutor — handles dynamic URL construction with accountId.
 * Cloudflare Workers AI uses the authenticated user's account ID in the URL.
 *
 * URL pattern: https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1/chat/completions
 * Auth: Bearer <API Token>
 * Docs: https://developers.cloudflare.com/workers-ai/
 *
 * Free tier: 10,000 Neurons/day = ~150 LLM responses or 500s Whisper audio
 * API Token: dash.cloudflare.com/profile/api-tokens
 * Account ID: right sidebar of dash.cloudflare.com
 */
export class CloudflareAIExecutor extends BaseExecutor {
  constructor() {
    super("cloudflare-ai", PROVIDERS["cloudflare-ai"] || {
      format: "openai"
    });
  }
  buildUrl(_model, _stream, _urlIndex = 0, credentials = null) {
    // Account ID can be stored in providerSpecificData or at top level credentials
    const accountId = credentials?.providerSpecificData?.accountId || credentials?.accountId || process.env.CLOUDFLARE_ACCOUNT_ID;
    if (!accountId) {
      throw new Error("Cloudflare Workers AI requires an Account ID. " + "Add it in provider settings under 'Account ID'. " + "Find it at: https://dash.cloudflare.com (right sidebar).");
    }
    return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;
  }
  buildHeaders(credentials, stream = true) {
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${credentials.apiKey || credentials.accessToken}`
    };
    if (stream) {
      headers["Accept"] = "text/event-stream";
    }
    return headers;
  }
  transformRequest(_model, body, _stream, _credentials) {
    // Cloudflare uses full model paths like @cf/meta/llama-3.3-70b-instruct — the model id
    // needs no transformation. But the Workers AI /ai/v1/chat/completions endpoint requires
    // each message `content` to be a plain string; it rejects the OpenAI content-part array
    // shape (`[{ type:"text", text }]`) with HTTP 400 (#2539). Flatten text parts to a string.
    if (!Array.isArray(body.messages)) return body;
    const flattenContent = content => {
      if (typeof content === "string" || !Array.isArray(content)) return content;
      return content.map(part => {
        if (!part || typeof part !== "object") return "";
        const p = part;
        return p.type === "text" && typeof p.text === "string" ? p.text : "";
      }).join("");
    };
    const messages = body.messages.map(msg => msg && Array.isArray(msg.content) ? {
      ...msg,
      content: flattenContent(msg.content)
    } : msg);
    return {
      ...body,
      messages
    };
  }
}
export default CloudflareAIExecutor;