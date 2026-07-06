import { PROVIDER_ID_TO_ALIAS, getModelStripTypes } from "../config/providerModels";
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function shouldStripPart(part, stripTypes) {
  const type = typeof part.type === "string" ? part.type : "";
  if (!type) return false;
  if (stripTypes.has(type)) return true;
  if (stripTypes.has("image") && (type === "image_url" || type === "image")) return true;
  if (stripTypes.has("audio") && (type === "input_audio" || type === "audio")) return true;
  return false;
}
export function stripIncompatibleMessageContent(messages, stripTypes) {
  if (!Array.isArray(messages) || stripTypes.length === 0) {
    return {
      messages,
      removedParts: 0
    };
  }
  const stripSet = new Set(stripTypes);
  let removedParts = 0;
  const sanitizedMessages = messages.map(message => {
    const record = asRecord(message);
    if (!Array.isArray(record.content)) {
      return message;
    }
    const filteredContent = record.content.filter(part => {
      const shouldStrip = shouldStripPart(asRecord(part), stripSet);
      if (shouldStrip) {
        removedParts += 1;
      }
      return !shouldStrip;
    });
    if (filteredContent.length > 0) {
      return {
        ...record,
        content: filteredContent
      };
    }
    return {
      ...record,
      content: [{
        type: "text",
        text: "[unsupported image/audio content removed]"
      }]
    };
  });
  return {
    messages: sanitizedMessages,
    removedParts
  };
}
export function getStripTypesForProviderModel(providerId, modelId) {
  const alias = PROVIDER_ID_TO_ALIAS[providerId] || providerId;
  return getModelStripTypes(alias, modelId);
}