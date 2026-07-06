import { isOpenAIResponsesStoreEnabled } from "../stubs/lib/providers/requestDefaults";
import { DEFAULT_RESPONSES_PREVIOUS_RESPONSE_ID_MODE, RESPONSES_PREVIOUS_RESPONSE_ID_MODES } from "../stubs/shared/constants/responsesPreviousResponseId";
import { FORMATS } from "../translator/formats";
const MODE_SET = new Set(RESPONSES_PREVIOUS_RESPONSE_ID_MODES);
function toRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
export function normalizeResponsesPreviousResponseIdMode(value) {
  if (typeof value === "string" && MODE_SET.has(value)) {
    return value;
  }
  return DEFAULT_RESPONSES_PREVIOUS_RESPONSE_ID_MODE;
}
export function shouldStripPreviousResponseId({
  mode,
  sourceFormat,
  targetFormat,
  credentials
}) {
  const normalizedMode = normalizeResponsesPreviousResponseIdMode(mode);
  if (normalizedMode === "preserve") return false;
  if (normalizedMode === "strip") return true;
  const isResponsesSource = sourceFormat === FORMATS.OPENAI_RESPONSES;
  const isResponsesTarget = targetFormat === FORMATS.OPENAI_RESPONSES;
  if (!isResponsesSource && !isResponsesTarget) return false;

  // `previous_response_id` is only safe when the upstream actually keeps
  // Responses state. OmniRoute defaults to stateless upstream calls, so auto
  // strips unless the connection explicitly opts into OpenAI Responses storage.
  const providerSpecificData = toRecord(toRecord(credentials).providerSpecificData);
  return !isOpenAIResponsesStoreEnabled(providerSpecificData);
}
export function applyResponsesPreviousResponseIdPolicy(body, options) {
  const mode = normalizeResponsesPreviousResponseIdMode(options.mode);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {
      body,
      stripped: false,
      mode
    };
  }
  const record = body;
  if (!Object.hasOwn(record, "previous_response_id")) {
    return {
      body,
      stripped: false,
      mode
    };
  }
  if (!shouldStripPreviousResponseId({
    ...options,
    mode
  })) {
    return {
      body,
      stripped: false,
      mode
    };
  }
  const next = {
    ...record
  };
  delete next.previous_response_id;
  return {
    body: next,
    stripped: true,
    mode
  };
}