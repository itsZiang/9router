import { CHAT_OPENAI_COMPAT_MODELS } from "../../shared";
export const xiaomi_mimoProvider = {
  id: "xiaomi-mimo",
  alias: "mimo",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.xiaomimimo.com/v1",
  authType: "apikey",
  authHeader: "bearer",
  models: CHAT_OPENAI_COMPAT_MODELS["xiaomi-mimo"]
};