import { CHAT_OPENAI_COMPAT_MODELS } from "../../shared";
export const lambda_aiProvider = {
  id: "lambda-ai",
  alias: "lambda",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.lambda.ai/v1/chat/completions",
  authType: "apikey",
  authHeader: "bearer",
  models: CHAT_OPENAI_COMPAT_MODELS["lambda-ai"]
};