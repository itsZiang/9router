/**
 * chatCore request-setup resolvers (Quality Gate v2 / Fase 9 — chatCore god-file decomposition).
 *
 * The first pure slice of handleChatCore's request-setup phase: the per-request model-routing
 * metadata resolved at the very top of the handler. Side-effect-free; future increments grow this
 * into the full ChatCoreContext carrier (setup / dispatch / streaming phases).
 */

/**
 * Resolve the per-request model-routing metadata at the top of handleChatCore. Pure: a function of
 * the injected modelInfo, the request body, and the resolved model id. Behaviour is byte-identical
 * to the previous inline code.
 */
export function resolveChatCoreRequestSetup(modelInfo, body, model) {
  const apiFormat = modelInfo && typeof modelInfo === "object" && "apiFormat" in modelInfo ? typeof modelInfo.apiFormat === "string" ? modelInfo.apiFormat : undefined : undefined;
  const customModelTargetFormat = modelInfo && typeof modelInfo === "object" && "targetFormat" in modelInfo ? typeof modelInfo.targetFormat === "string" ? modelInfo.targetFormat : undefined : undefined;
  const requestedModel = typeof body?.model === "string" && body.model.trim().length > 0 ? body.model : model;
  return {
    apiFormat,
    customModelTargetFormat,
    requestedModel
  };
}