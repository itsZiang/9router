import { CHAT_OPENAI_COMPAT_MODELS } from "../../shared";
export const wandbProvider = {
  id: "wandb",
  alias: "wandb",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.inference.wandb.ai/v1/chat/completions",
  authType: "apikey",
  authHeader: "bearer",
  models: CHAT_OPENAI_COMPAT_MODELS.wandb
};