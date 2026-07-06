const DEFAULT_FETCH_TIMEOUT_MS = 600_000;
const DEFAULT_FETCH_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_FETCH_KEEPALIVE_TIMEOUT_MS = 4_000;

function readTimeoutMs(env, name, defaultValue) {
  const raw = (env[name] ?? "").trim();
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return defaultValue;
  }
  return parsed;
}

export function getUpstreamTimeoutConfig(env = process.env, logger = () => {}) {
  const fetchTimeoutMs = readTimeoutMs(env, "REQUEST_TIMEOUT_MS", DEFAULT_FETCH_TIMEOUT_MS);
  const fetchHeadersTimeoutMs = readTimeoutMs(env, "FETCH_HEADERS_TIMEOUT_MS", fetchTimeoutMs);
  const fetchBodyTimeoutMs = readTimeoutMs(env, "FETCH_BODY_TIMEOUT_MS", fetchTimeoutMs);
  const fetchConnectTimeoutMs = readTimeoutMs(
    env,
    "FETCH_CONNECT_TIMEOUT_MS",
    DEFAULT_FETCH_CONNECT_TIMEOUT_MS
  );
  const fetchKeepAliveTimeoutMs = readTimeoutMs(
    env,
    "FETCH_KEEPALIVE_TIMEOUT_MS",
    DEFAULT_FETCH_KEEPALIVE_TIMEOUT_MS
  );

  return {
    fetchTimeoutMs,
    fetchHeadersTimeoutMs,
    fetchBodyTimeoutMs,
    fetchConnectTimeoutMs,
    fetchKeepAliveTimeoutMs,
  };
}