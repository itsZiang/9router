import { CHAT_OPENAI_COMPAT_MODELS } from "../../shared";
export const predibaseProvider = {
  id: "predibase",
  alias: "predibase",
  format: "openai",
  executor: "default",
  baseUrl: "https://serving.app.predibase.com/v1/chat/completions",
  authType: "apikey",
  authHeader: "bearer",
  models: CHAT_OPENAI_COMPAT_MODELS.predibase
};