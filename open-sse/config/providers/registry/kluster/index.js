export const klusterProvider = {
  id: "kluster",
  alias: "kluster",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.kluster.ai/v1/chat/completions",
  authType: "apikey",
  authHeader: "bearer",
  models: [{
    id: "auto",
    name: "Auto"
  }]
};