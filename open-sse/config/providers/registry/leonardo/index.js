export const leonardoProvider = {
  id: "leonardo",
  alias: "leo",
  format: "openai",
  executor: "default",
  baseUrl: "https://cloud.leonardo.ai/api/rest/v1",
  authType: "apikey",
  authHeader: "bearer",
  models: [{
    id: "phoenix",
    name: "Phoenix"
  }, {
    id: "sdxl",
    name: "SDXL"
  }]
};