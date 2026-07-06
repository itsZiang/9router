import { CHAT_OPENAI_COMPAT_MODELS } from "../../shared";
export const llamagateProvider = {
  id: "llamagate",
  alias: "llamagate",
  format: "openai",
  executor: "default",
  baseUrl: "https://llamagate.ai/v1/chat/completions",
  authType: "apikey",
  authHeader: "bearer",
  models: CHAT_OPENAI_COMPAT_MODELS.llamagate
};