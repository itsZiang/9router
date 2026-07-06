import { AntigravityExecutor } from "./antigravity";
import { GithubExecutor } from "./github";
import { QoderExecutor } from "./qoder";
import { KiroExecutor } from "./kiro";
import { CodexExecutor } from "./codex";
import { CursorExecutor } from "./cursor";
import { TraeExecutor } from "./trae";
import { DefaultExecutor } from "./default";
import { BedrockExecutor } from "./bedrock";
import { GlmExecutor } from "./glm";
import { PollinationsExecutor } from "./pollinations";
import { CloudflareAIExecutor } from "./cloudflare-ai";
import { OpencodeExecutor } from "./opencode";
import { PuterExecutor } from "./puter";
import { VertexExecutor } from "./vertex";
import { CliproxyapiExecutor } from "./cliproxyapi";
import { NineRouterExecutor } from "./ninerouter";
import { PerplexityWebExecutor } from "./perplexity-web";
import { GrokWebExecutor } from "./grok-web";
import { GeminiWebExecutor } from "./gemini-web";
import { GeminiBusinessExecutor } from "./gemini-business";
import { ChatGptWebExecutor } from "./chatgpt-web";
import { BlackboxWebExecutor } from "./blackbox-web";
import { MuseSparkWebExecutor } from "./muse-spark-web";
import { AzureOpenAIExecutor } from "./azure-openai";
import { CommandCodeExecutor } from "./commandCode";
import { GitlabExecutor } from "./gitlab";
import { NlpCloudExecutor } from "./nlpcloud";
import { WindsurfExecutor } from "./windsurf";
import { DevinCliExecutor } from "./devin-cli";
import { DeepSeekWebWithAutoRefreshExecutor } from "./deepseek-web-with-auto-refresh";
import { AdaptaWebExecutor } from "./adapta-web";
import { ClaudeWebWithAutoRefresh } from "./claude-web-with-auto-refresh";
import { CopilotWebExecutor } from "./copilot-web";
import { CopilotM365WebExecutor } from "./copilot-m365-web";
import { VeoAIFreeWebExecutor } from "./veoaifree-web";
import { DuckDuckGoWebExecutor } from "./duckduckgo-web";
import { T3ChatWebExecutor } from "./t3-chat-web";
import { InnerAiExecutor } from "./inner-ai";
import { HuggingChatExecutor } from "./huggingchat";
import { PoeWebExecutor } from "./poe-web";
import { VeniceWebExecutor } from "./venice-web";
import { V0VercelWebExecutor } from "./v0-vercel-web";
import { KimiWebExecutor } from "./kimi-web";
import { DoubaoWebExecutor } from "./doubao-web";
import { QwenWebExecutor } from "./qwen-web";
import { KimiExecutor } from "./kimi";
import { TheOldLlmExecutor } from "./theoldllm";
import { ChipotleExecutor } from "./chipotle";
import { LMArenaExecutor } from "./lmarena";
import { MimocodeExecutor } from "./mimocode";
import { GrokCliExecutor } from "./grok-cli";
import { CodeBuddyCnExecutor } from "./codebuddy-cn";
import { ZenmuxFreeExecutor } from "./zenmux-free";
import { KimchiExecutor } from "./kimchi";
const executors = {
  antigravity: new AntigravityExecutor(),
  agy: new AntigravityExecutor(),
  github: new GithubExecutor(),
  qoder: new QoderExecutor(),
  kiro: new KiroExecutor(),
  "amazon-q": new KiroExecutor("amazon-q"),
  bedrock: new BedrockExecutor(),
  codex: new CodexExecutor(),
  cursor: new CursorExecutor(),
  trae: new TraeExecutor(),
  glm: new GlmExecutor("glm"),
  "glm-cn": new GlmExecutor("glm-cn"),
  glmt: new GlmExecutor("glmt"),
  cu: new CursorExecutor(),
  // Alias for cursor
  "azure-openai": new AzureOpenAIExecutor(),
  "command-code": new CommandCodeExecutor(),
  cmd: new CommandCodeExecutor(),
  // Alias
  gitlab: new GitlabExecutor(),
  "gitlab-duo": new GitlabExecutor("gitlab-duo"),
  nlpcloud: new NlpCloudExecutor(),
  pollinations: new PollinationsExecutor(),
  pol: new PollinationsExecutor(),
  // Alias
  "cloudflare-ai": new CloudflareAIExecutor(),
  cf: new CloudflareAIExecutor(),
  // Alias
  "opencode-zen": new OpencodeExecutor("opencode-zen"),
  "opencode-go": new OpencodeExecutor("opencode-go"),
  opencode: new OpencodeExecutor("opencode-zen"),
  // Alias for opencode-zen
  puter: new PuterExecutor(),
  pu: new PuterExecutor(),
  // Alias
  vertex: new VertexExecutor(),
  "vertex-partner": new VertexExecutor(),
  cliproxyapi: new CliproxyapiExecutor(),
  cpa: new CliproxyapiExecutor(),
  // Alias
  "9router": new NineRouterExecutor(),
  nr: new NineRouterExecutor(),
  // Alias
  "perplexity-web": new PerplexityWebExecutor(),
  "pplx-web": new PerplexityWebExecutor(),
  // Alias
  "grok-web": new GrokWebExecutor(),
  "claude-web": new ClaudeWebWithAutoRefresh(),
  "cw-web": new ClaudeWebWithAutoRefresh(),
  // Alias
  "gemini-web": new GeminiWebExecutor(),
  gweb: new GeminiWebExecutor(),
  // Alias
  "gemini-business": new GeminiBusinessExecutor(),
  gembiz: new GeminiBusinessExecutor(),
  // Alias
  "chatgpt-web": new ChatGptWebExecutor(),
  "cgpt-web": new ChatGptWebExecutor(),
  // Alias
  "blackbox-web": new BlackboxWebExecutor(),
  "bb-web": new BlackboxWebExecutor(),
  // Alias
  "muse-spark-web": new MuseSparkWebExecutor(),
  "ms-web": new MuseSparkWebExecutor(),
  // Alias
  windsurf: new WindsurfExecutor(),
  ws: new WindsurfExecutor(),
  // Alias
  "devin-cli": new DevinCliExecutor(),
  devin: new DevinCliExecutor(),
  // Alias
  "deepseek-web": new DeepSeekWebWithAutoRefreshExecutor(),
  "ds-web": new DeepSeekWebWithAutoRefreshExecutor(),
  // Alias
  "adapta-web": new AdaptaWebExecutor(),
  "adp-web": new AdaptaWebExecutor(),
  // Alias
  "copilot-web": new CopilotWebExecutor(),
  "copilot-m365-web": new CopilotM365WebExecutor(),
  copilot: new CopilotWebExecutor(),
  // Alias
  "veoaifree-web": new VeoAIFreeWebExecutor(),
  "veo-free": new VeoAIFreeWebExecutor(),
  // Alias
  "duckduckgo-web": new DuckDuckGoWebExecutor(),
  ddgw: new DuckDuckGoWebExecutor(),
  // Alias
  "t3-web": new T3ChatWebExecutor(),
  t3chat: new T3ChatWebExecutor(),
  // Alias
  "inner-ai": new InnerAiExecutor(),
  "in-ai": new InnerAiExecutor(),
  // Alias
  huggingchat: new HuggingChatExecutor(),
  hc: new HuggingChatExecutor(),
  // Alias
  "poe-web": new PoeWebExecutor(),
  poe: new PoeWebExecutor(),
  // Alias
  "venice-web": new VeniceWebExecutor(),
  ven: new VeniceWebExecutor(),
  // Alias
  "v0-vercel-web": new V0VercelWebExecutor(),
  v0: new V0VercelWebExecutor(),
  // Alias
  "kimi-web": new KimiWebExecutor(),
  "kimi-coding-apikey": new KimiExecutor(),
  // Alias
  "kimi-coding": new KimiExecutor(),
  // Alias
  "doubao-web": new DoubaoWebExecutor(),
  db: new DoubaoWebExecutor(),
  // Alias
  "qwen-web": new QwenWebExecutor(),
  qw: new QwenWebExecutor(),
  // Alias
  theoldllm: new TheOldLlmExecutor(),
  tllm: new TheOldLlmExecutor(),
  // Alias
  chipotle: new ChipotleExecutor(),
  pepper: new ChipotleExecutor(),
  // Alias
  lmarena: new LMArenaExecutor(),
  lma: new LMArenaExecutor(),
  // Alias
  mimocode: new MimocodeExecutor(),
  mcode: new MimocodeExecutor(),
  // Alias
  "grok-cli": new GrokCliExecutor(),
  gc: new GrokCliExecutor(),
  // Alias
  "codebuddy-cn": new CodeBuddyCnExecutor(),
  cbcn: new CodeBuddyCnExecutor(),
  // Alias for codebuddy-cn
  "zenmux-free": new ZenmuxFreeExecutor(),
  zmf: new ZenmuxFreeExecutor(), // Alias for zenmux-free
  kimchi: new KimchiExecutor()
};
const defaultCache = new Map();
export function getExecutor(provider) {
  if (executors[provider]) return executors[provider];
  if (!defaultCache.has(provider)) defaultCache.set(provider, new DefaultExecutor(provider));
  return defaultCache.get(provider);
}
export function hasSpecializedExecutor(provider) {
  return !!executors[provider];
}
export { BaseExecutor } from "./base";
export { AntigravityExecutor } from "./antigravity";
export { GithubExecutor } from "./github";
export { QoderExecutor } from "./qoder";
export { KiroExecutor } from "./kiro";
export { CodexExecutor } from "./codex";
export { CursorExecutor } from "./cursor";
export { TraeExecutor } from "./trae";
export { DefaultExecutor } from "./default";
export { BedrockExecutor } from "./bedrock";
export { GlmExecutor } from "./glm";
export { PollinationsExecutor } from "./pollinations";
export { CloudflareAIExecutor } from "./cloudflare-ai";
export { OpencodeExecutor } from "./opencode";
export { PuterExecutor } from "./puter";
export { CliproxyapiExecutor } from "./cliproxyapi";
export { NineRouterExecutor } from "./ninerouter";
export { VertexExecutor } from "./vertex";
export { PerplexityWebExecutor } from "./perplexity-web";
export { GrokWebExecutor } from "./grok-web";
export { GeminiWebExecutor } from "./gemini-web";
export { KieExecutor } from "./kie";
export { ChatGptWebExecutor } from "./chatgpt-web";
export { BlackboxWebExecutor } from "./blackbox-web";
export { MuseSparkWebExecutor } from "./muse-spark-web";
export { AzureOpenAIExecutor } from "./azure-openai";
export { CommandCodeExecutor } from "./commandCode";
export { GitlabExecutor } from "./gitlab";
export { NlpCloudExecutor } from "./nlpcloud";
export { WindsurfExecutor } from "./windsurf";
export { DevinCliExecutor } from "./devin-cli";
export { CopilotWebExecutor } from "./copilot-web";
export { CopilotM365WebExecutor } from "./copilot-m365-web";
export { VeoAIFreeWebExecutor } from "./veoaifree-web";
export { DuckDuckGoWebExecutor } from "./duckduckgo-web";
export { ClaudeWebExecutor } from "./claude-web";
export { DeepSeekWebExecutor } from "./deepseek-web";
export { DeepSeekWebWithAutoRefreshExecutor } from "./deepseek-web-with-auto-refresh";
export { AdaptaWebExecutor } from "./adapta-web";
export { T3ChatWebExecutor } from "./t3-chat-web";
export { InnerAiExecutor } from "./inner-ai";
export { QwenWebExecutor } from "./qwen-web";
export { TheOldLlmExecutor } from "./theoldllm";
export { ChipotleExecutor } from "./chipotle";
export { LMArenaExecutor } from "./lmarena";
export { MimocodeExecutor } from "./mimocode";
export { GrokCliExecutor } from "./grok-cli";
export { CodeBuddyCnExecutor } from "./codebuddy-cn";
export { ZenmuxFreeExecutor } from "./zenmux-free";