import { CHAT_OPENAI_COMPAT_MODELS } from "../../shared";
export const nanogptProvider = {
  id: "nanogpt",
  alias: "nanogpt",
  format: "openai",
  executor: "default",
  baseUrl: "https://nano-gpt.com/api/v1/chat/completions",
  authType: "apikey",
  authHeader: "bearer",
  models: CHAT_OPENAI_COMPAT_MODELS.nanogpt
};