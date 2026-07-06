import { CHAT_OPENAI_COMPAT_MODELS } from "../../shared";
export const ai21Provider = {
  id: "ai21",
  alias: "ai21",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.ai21.com/studio/v1/chat/completions",
  authType: "apikey",
  authHeader: "bearer",
  models: CHAT_OPENAI_COMPAT_MODELS.ai21
};