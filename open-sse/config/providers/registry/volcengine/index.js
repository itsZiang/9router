import { CHAT_OPENAI_COMPAT_MODELS } from "../../shared";
export const volcengineProvider = {
  id: "volcengine",
  alias: "volcengine",
  format: "openai",
  executor: "default",
  baseUrl: "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
  authType: "apikey",
  authHeader: "bearer",
  models: CHAT_OPENAI_COMPAT_MODELS.volcengine
};