import { CHAT_OPENAI_COMPAT_MODELS } from "../../shared";
export const codestralProvider = {
  id: "codestral",
  alias: "codestral",
  format: "openai",
  executor: "default",
  baseUrl: "https://codestral.mistral.ai/v1/chat/completions",
  authType: "apikey",
  authHeader: "bearer",
  models: CHAT_OPENAI_COMPAT_MODELS.codestral
};