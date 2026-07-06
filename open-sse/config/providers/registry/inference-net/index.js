import { CHAT_OPENAI_COMPAT_MODELS } from "../../shared";
export const inference_netProvider = {
  id: "inference-net",
  alias: "inet",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.inference.net/v1/chat/completions",
  authType: "apikey",
  authHeader: "bearer",
  models: CHAT_OPENAI_COMPAT_MODELS["inference-net"]
};