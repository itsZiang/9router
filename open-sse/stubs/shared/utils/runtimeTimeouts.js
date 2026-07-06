export const MAX_TIMER_TIMEOUT_MS = 0;

export function getStainlessTimeoutSeconds() {
  return null;
}

export function getTlsClientTimeoutConfig() {
  return null;
}

export function getUpstreamTimeoutConfig(env, warn) {
  return {
    fetchTimeoutMs: 30000,
    streamIdleTimeoutMs: 600000,
    streamReadinessTimeoutMs: 45000,
    streamReadinessMaxTimeoutMs: 90000,
  };
}

const _defaultExport = {};
export default _defaultExport;
