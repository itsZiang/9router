export const udioProvider = {
  id: "udio",
  alias: "udio",
  format: "openai",
  executor: "default",
  baseUrl: "https://www.udio.com/api/generate-proxy",
  authType: "apikey",
  authHeader: "cookie",
  models: [{
    id: "udio-default",
    name: "Udio Default"
  }]
};