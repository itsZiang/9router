import { buildOpenAiCompatibleRegistryEntry } from "../../shared";
export const nebiusProvider = buildOpenAiCompatibleRegistryEntry({
  id: "nebius",
  alias: "nebius",
  baseUrl: "https://api.tokenfactory.nebius.com/v1/chat/completions",
  models: [{
    id: "meta-llama/Llama-3.3-70B-Instruct",
    name: "Llama 3.3 70B Instruct"
  }]
});