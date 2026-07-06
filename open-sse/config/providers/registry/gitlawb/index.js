import { CHAT_OPENAI_COMPAT_MODELS } from "../../shared";
export const gitlawbProvider = {
  id: "gitlawb",
  alias: "glb",
  format: "openai",
  executor: "default",
  baseUrl: "https://opengateway.gitlawb.com/v1/xiaomi-mimo",
  authType: "apikey",
  authHeader: "bearer",
  headers: {
    "User-Agent": "OpenClaude/1.0 (linux; x86_64)",
    "X-Title": "OpenClaude CLI",
    "HTTP-Referer": "https://github.com/Gitlawb/openclaude"
  },
  models: CHAT_OPENAI_COMPAT_MODELS["gitlawb"]
};