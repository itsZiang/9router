import { CHAT_OPENAI_COMPAT_MODELS } from "../../shared";
export const v0_vercelProvider = {
  id: "v0-vercel",
  alias: "v0",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.v0.dev/v1/chat/completions",
  authType: "apikey",
  authHeader: "bearer",
  models: CHAT_OPENAI_COMPAT_MODELS["v0-vercel"]
};