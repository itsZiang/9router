export const DEFAULT_AGENT_GOAL_READINESS_MAX_TIMEOUT_MS = 600_000;
const GOAL_COMMAND_RE = /(^|[\s"'`])\/goal(?=$|[\s"'`:;,.!?])/i;
const MAX_VISITED_NODES = 5_000;
const MAX_STRING_CHARS = 256_000;
function readHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") {
    return headers.get(name);
  }
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lower) continue;
    if (Array.isArray(value)) return value.join(",");
    return typeof value === "string" ? value : null;
  }
  return null;
}
function parseBoolean(value, fallback) {
  if (value == null || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return fallback;
}
function readPositiveMs(env, name, fallback) {
  const raw = env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
function hasGoalCommandText(value) {
  const sample = value.length > MAX_STRING_CHARS ? value.slice(0, MAX_STRING_CHARS) : value;
  return GOAL_COMMAND_RE.test(sample);
}
export function isAgentGoalRequestBody(body) {
  const seen = new Set();
  let visited = 0;
  const visit = (value, depth) => {
    if (visited++ > MAX_VISITED_NODES || depth > 10) return false;
    if (typeof value === "string") return hasGoalCommandText(value);
    if (!value || typeof value !== "object") return false;
    if (seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        if (visit(item, depth + 1)) return true;
      }
      return false;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === "metadata" || key === "usage") continue;
      if (visit(child, depth + 1)) return true;
    }
    return false;
  };
  return visit(body, 0);
}
export function resolveAgentGoalPolicy(body, headers = null, env = process.env) {
  // Kill-switch (default ON — preserves existing behavior). When explicitly
  // disabled, the whole heuristic is a no-op: it never elevates readiness
  // timeouts or stream recovery, regardless of request body/headers. This
  // mitigates client-controlled timeout amplification when an operator does
  // not want request bodies/headers to influence upstream timeout budgets.
  const policyEnabled = parseBoolean(env.OMNIROUTE_AGENT_GOAL_POLICY_ENABLED, true);
  if (!policyEnabled) {
    return {
      detected: false,
      readinessMaxTimeoutMs: DEFAULT_AGENT_GOAL_READINESS_MAX_TIMEOUT_MS,
      streamRecoveryEnabled: false
    };
  }
  const forcedByHeader = parseBoolean(readHeader(headers, "x-omniroute-agent-goal"), false);
  const detected = forcedByHeader || isAgentGoalRequestBody(body);
  const readinessMaxTimeoutMs = readPositiveMs(env, "OMNIROUTE_AGENT_GOAL_READINESS_MAX_TIMEOUT_MS", DEFAULT_AGENT_GOAL_READINESS_MAX_TIMEOUT_MS);
  const streamRecoveryEnabled = detected && parseBoolean(env.OMNIROUTE_AGENT_GOAL_STREAM_RECOVERY, true);
  return {
    detected,
    readinessMaxTimeoutMs,
    streamRecoveryEnabled
  };
}