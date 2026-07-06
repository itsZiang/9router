import { CHAT_OPENAI_COMPAT_MODELS } from "../../shared";
export const gigachatProvider = {
  id: "gigachat",
  alias: "gigachat",
  format: "openai",
  executor: "default",
  baseUrl: "https://gigachat.devices.sberbank.ru/api/v1",
  authType: "apikey",
  authHeader: "bearer",
  models: CHAT_OPENAI_COMPAT_MODELS.gigachat
};