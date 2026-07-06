// Patch global fetch with proxy support (must be first)
import "./utils/proxyFetch";

// Config
export { PROVIDERS, OAUTH_ENDPOINTS, CACHE_TTL, DEFAULT_MAX_TOKENS, CLAUDE_SYSTEM_PROMPT, COOLDOWN_MS, BACKOFF_CONFIG } from "./config/constants";
export { PROVIDER_MODELS, getProviderModels, getDefaultModel, isValidModel, findModelName, getModelTargetFormat, PROVIDER_ID_TO_ALIAS, getModelsByProviderId } from "./config/providerModels";

// Translator
export { FORMATS } from "./translator/formats";
export { register, translateRequest, translateResponse, needsTranslation, initState, initTranslators } from "./translator/index";

// Services
export { detectFormat, detectFormatFromEndpoint, getProviderConfig, buildProviderUrl, buildProviderHeaders, getTargetFormat } from "./services/provider";
export { parseModel, resolveModelAliasFromMap, getModelInfoCore } from "./services/model";
export { checkFallbackError, isAccountUnavailable, getUnavailableUntil, filterAvailableAccounts, isProviderInCooldown, getProviderCooldownRemainingMs, getProvidersInCooldown } from "./services/accountFallback";
export { TOKEN_EXPIRY_BUFFER_MS, refreshAccessToken, refreshClaudeOAuthToken, refreshGoogleToken, refreshQwenToken, refreshCodexToken, refreshQoderToken, refreshGitHubToken, refreshCopilotToken, getAccessToken, refreshTokenByProvider } from "./services/tokenRefresh";

// Handlers
export { handleChatCore, isTokenExpiringSoon } from "./handlers/chatCore";
export { createStreamController, pipeWithDisconnect, createDisconnectAwareStream } from "./utils/streamHandler";

// Executors
export { getExecutor, hasSpecializedExecutor } from "./executors/index";

// Utils
export { errorResponse, formatProviderError } from "./utils/error";
export { createSSETransformStreamWithLogger, createPassthroughStreamWithLogger } from "./utils/stream";

// Embeddings
export { handleEmbedding } from "./handlers/embeddings";
export { EMBEDDING_PROVIDERS, getEmbeddingProvider, parseEmbeddingModel, getAllEmbeddingModels } from "./config/embeddingRegistry";

// Image Generation
export { handleImageGeneration } from "./handlers/imageGeneration";
export { IMAGE_PROVIDERS, getImageProvider, parseImageModel, getAllImageModels } from "./config/imageRegistry";

// Think Tag Parser
export { hasThinkTags, extractThinkTags, processStreamingThinkDelta, flushThinkBuffer } from "./utils/thinkTagParser";

// Rerank
export { handleRerank } from "./handlers/rerank";
export { RERANK_PROVIDERS, getRerankProvider, parseRerankModel, getAllRerankModels } from "./config/rerankRegistry";

// Audio (Transcription + Speech)
export { handleAudioTranscription } from "./handlers/audioTranscription";
export { handleAudioSpeech } from "./handlers/audioSpeech";
export { AUDIO_TRANSCRIPTION_PROVIDERS, AUDIO_SPEECH_PROVIDERS, getTranscriptionProvider, getSpeechProvider, parseTranscriptionModel, parseSpeechModel, getAllAudioModels } from "./config/audioRegistry";

// Moderations
export { handleModeration } from "./handlers/moderations";
export { MODERATION_PROVIDERS, getModerationProvider, parseModerationModel, getAllModerationModels } from "./config/moderationRegistry";

// Video Generation
export { handleVideoGeneration } from "./handlers/videoGeneration";
export { VIDEO_PROVIDERS, getVideoProvider, parseVideoModel, getAllVideoModels } from "./config/videoRegistry";

// Music Generation
export { handleMusicGeneration } from "./handlers/musicGeneration";
export { MUSIC_PROVIDERS, getMusicProvider, parseMusicModel, getAllMusicModels } from "./config/musicRegistry";

// Registry Utilities
export { parseModelFromRegistry, getAllModelsFromRegistry, buildAuthHeaders } from "./config/registryUtils";