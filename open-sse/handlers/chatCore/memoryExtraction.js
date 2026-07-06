import { capMemoryExtractionText, MEMORY_EXTRACTION_TEXT_LIMIT } from "./logTruncation";
export function extractMemoryTextFromResponse(response) {
  if (!response || typeof response !== "object") return "";
  const openAIText = response?.choices?.[0]?.message?.content;
  if (typeof openAIText === "string") {
    return capMemoryExtractionText(openAIText.trim());
  }
  if (Array.isArray(response?.content)) {
    const contentText = response.content.filter(part => part?.type === "text" && typeof part?.text === "string").map(part => String(part.text).trim()).filter(Boolean).join("\n");
    if (contentText) return capMemoryExtractionText(contentText);
  }
  if (typeof response?.output_text === "string") {
    return capMemoryExtractionText(response.output_text.trim());
  }
  return "";
}
export function extractMemoryTextFromRequestBody(body) {
  if (!body || typeof body !== "object") return "";
  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (messages && messages.length > 0) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (msg?.role !== "user") continue;
      if (typeof msg.content === "string" && msg.content.trim().length > 0) {
        return capMemoryExtractionText(msg.content.trim());
      }
      if (Array.isArray(msg.content)) {
        const text = msg.content.map(part => {
          if (typeof part?.text === "string") return part.text.trim();
          if (part?.type === "input_text" && typeof part?.text === "string") return part.text.trim();
          return "";
        }).filter(Boolean).join("\n").trim();
        if (text) return capMemoryExtractionText(text);
      }
    }
  }
  const input = Array.isArray(body.input) ? body.input : null;
  if (input && input.length > 0) {
    for (let i = input.length - 1; i >= 0; i -= 1) {
      const item = input[i];
      const role = typeof item?.role === "string" ? item.role.trim().toLowerCase() : "";
      const itemType = typeof item?.type === "string" ? item.type.trim().toLowerCase() : "";
      if (role && role !== "user") continue;
      if (itemType && itemType !== "message") continue;
      if (typeof item?.content === "string" && item.content.trim()) {
        return capMemoryExtractionText(item.content.trim());
      }
      if (Array.isArray(item?.content)) {
        const text = item.content.map(part => {
          if (typeof part?.text === "string") return part.text.trim();
          if (part?.type === "input_text" && typeof part?.text === "string") return part.text.trim();
          return "";
        }).filter(Boolean).join("\n").trim();
        if (text) return capMemoryExtractionText(text);
      }
    }
    const tailChunks = [];
    let tailLength = 0;
    for (let i = input.length - 1; i >= 0 && tailLength < MEMORY_EXTRACTION_TEXT_LIMIT; i -= 1) {
      const item = input[i];
      const text = (() => {
        const role = typeof item?.role === "string" ? item.role.trim().toLowerCase() : "";
        const itemType = typeof item?.type === "string" ? item.type.trim().toLowerCase() : "";
        if (role && role !== "user") return "";
        if (itemType && itemType !== "message") return "";
        if (typeof item?.content === "string") return item.content.trim();
        if (Array.isArray(item?.content)) {
          return item.content.map(part => {
            if (typeof part?.text === "string") return part.text.trim();
            if (part?.type === "input_text" && typeof part?.text === "string") return part.text.trim();
            return "";
          }).filter(Boolean).join("\n").trim();
        }
        return "";
      })();
      if (!text) continue;
      tailChunks.unshift(text);
      tailLength += text.length + 1;
    }
    const chunks = tailChunks.join("\n").trim();
    if (chunks) return capMemoryExtractionText(chunks);
  }
  return "";
}
export function resolveMemoryOwnerId(apiKeyInfo) {
  const rawId = apiKeyInfo?.id;
  if (typeof rawId === "string" && rawId.trim().length > 0) {
    return rawId;
  }
  return null;
}