import { CHAT_OPENAI_COMPAT_MODELS } from "../../shared";
export const friendliaiProvider = {
  id: "friendliai",
  alias: "friendli",
  format: "openai",
  executor: "default",
  // #5430: serverless endpoint — a `flp_*` serverless token gets 403 Forbidden on the
  // /dedicated path (verified live). Serverless accepts it and serves the public models.
  baseUrl: "https://api.friendli.ai/serverless/v1/chat/completions",
  modelsUrl: "https://api.friendli.ai/serverless/v1/models",
  authType: "apikey",
  authHeader: "bearer",
  models: CHAT_OPENAI_COMPAT_MODELS.friendliai
};