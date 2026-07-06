import { CHAT_OPENAI_COMPAT_MODELS } from "../../shared";
export const snowflakeProvider = {
  id: "snowflake",
  alias: "snowflake",
  format: "openai",
  executor: "default",
  baseUrl: "https://{account}.snowflakecomputing.com/api/v2",
  authType: "apikey",
  authHeader: "bearer",
  models: CHAT_OPENAI_COMPAT_MODELS.snowflake
};