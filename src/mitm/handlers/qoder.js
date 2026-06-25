const { log, err } = require("../logger");
const { IS_DEV } = require("../config");

/**
 * Qoder (Alibaba) MITM handler.
 *
 * Phase 1 (current): passthrough + capture.
 *   - Forwards every request to the real upstream (api2/openapi/center.qoder.sh)
 *   - The server.js passthrough() already tees request + response to dump files
 *     when ENABLE_FILE_LOG (IS_DEV) is on, so we get readable captures in
 *     data/logs/mitm/*.req.json + *.res.txt
 *   - No translation yet — we need real captures to learn the chat request/
 *     response shape (Qoder's inference endpoint is dynamically resolved via
 *     /algo/api/v3/service/region/endpoints and the path is not hardcoded in
 *     the binary).
 *
 * Phase 2 (after captures): translate Qoder <-> OpenAI like kiro.js does.
 *   - Qoder transcript format looks Anthropic-compatible (type:"message",
 *     stop_reason:"end_turn", content:[{type:"text",text}]) so the translator
 *     should be simpler than Kiro's AWS EventStream binary parser.
 *
 * Auth observed: Authorization: Bearer <PAT> (qoder-pat). PAT is stored
 * encrypted in ~/.qoder/.auth/user. QODER_AUTH_MANAGED_TOKEN env can inject
 * a plaintext PAT directly.
 */
async function intercept(req, res, bodyBuffer, mappedModel, passthrough) {
  if (IS_DEV) {
    const host = (req.headers.host || "").split(":")[0];
    log(`[Qoder] passthrough ${req.method} ${host}${req.url}`);
  }
  return passthrough(req, res, bodyBuffer);
}

module.exports = { intercept };
