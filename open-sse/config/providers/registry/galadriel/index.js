import { CHAT_OPENAI_COMPAT_MODELS } from "../../shared";
export const galadrielProvider = {
  id: "galadriel",
  alias: "galadriel",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.galadriel.ai/v1/chat/completions",
  authType: "apikey",
  authHeader: "bearer",
  models: CHAT_OPENAI_COMPAT_MODELS.galadriel
};