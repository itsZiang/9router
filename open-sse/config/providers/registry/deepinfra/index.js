import { CHAT_OPENAI_COMPAT_MODELS } from "../../shared";
export const deepinfraProvider = {
  id: "deepinfra",
  alias: "deepinfra",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.deepinfra.com/v1/openai/chat/completions",
  authType: "apikey",
  authHeader: "bearer",
  models: CHAT_OPENAI_COMPAT_MODELS.deepinfra
};