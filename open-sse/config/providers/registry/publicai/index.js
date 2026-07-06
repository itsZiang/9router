import { CHAT_OPENAI_COMPAT_MODELS } from "../../shared";
export const publicaiProvider = {
  id: "publicai",
  alias: "publicai",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.publicai.co/v1/chat/completions",
  authType: "apikey",
  authHeader: "bearer",
  models: CHAT_OPENAI_COMPAT_MODELS.publicai
};