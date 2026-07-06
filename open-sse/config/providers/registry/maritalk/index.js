import { CHAT_OPENAI_COMPAT_MODELS, MARITALK_DEFAULT_BASE_URL } from "../../shared";
export const maritalkProvider = {
  id: "maritalk",
  alias: "maritalk",
  format: "openai",
  executor: "default",
  baseUrl: MARITALK_DEFAULT_BASE_URL,
  authType: "apikey",
  authHeader: "key",
  models: CHAT_OPENAI_COMPAT_MODELS.maritalk
};