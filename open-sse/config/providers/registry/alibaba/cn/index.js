import { ALIBABA_DASHSCOPE_MODELS } from "../../../shared";
export const alibaba_cnProvider = {
  id: "alibaba-cn",
  alias: "ali-cn",
  format: "openai",
  executor: "default",
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
  modelsUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1/models",
  authType: "apikey",
  authHeader: "bearer",
  models: ALIBABA_DASHSCOPE_MODELS,
  passthroughModels: true
};