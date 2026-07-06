import { CHAT_OPENAI_COMPAT_MODELS } from "../../shared";
export const vercel_ai_gatewayProvider = {
  id: "vercel-ai-gateway",
  alias: "vag",
  format: "openai",
  executor: "default",
  baseUrl: "https://ai-gateway.vercel.sh/v1/chat/completions",
  authType: "apikey",
  authHeader: "bearer",
  models: CHAT_OPENAI_COMPAT_MODELS["vercel-ai-gateway"]
};