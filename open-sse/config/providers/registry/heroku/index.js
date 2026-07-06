import { CHAT_OPENAI_COMPAT_MODELS } from "../../shared";
export const herokuProvider = {
  id: "heroku",
  alias: "heroku",
  format: "openai",
  executor: "default",
  baseUrl: "https://us.inference.heroku.com/v1/chat/completions",
  authType: "apikey",
  authHeader: "bearer",
  models: CHAT_OPENAI_COMPAT_MODELS.heroku
};