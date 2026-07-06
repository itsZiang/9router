import { CHAT_OPENAI_COMPAT_MODELS } from "../../shared";
export const nscaleProvider = {
  id: "nscale",
  alias: "nscale",
  format: "openai",
  executor: "default",
  baseUrl: "https://inference.api.nscale.com/v1/chat/completions",
  authType: "apikey",
  authHeader: "bearer",
  models: CHAT_OPENAI_COMPAT_MODELS.nscale
};