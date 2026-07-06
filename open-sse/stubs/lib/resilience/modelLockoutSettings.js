// Auto-generated stub: stubs/lib/resilience/modelLockoutSettings
export const DEFAULT_MODEL_LOCKOUT_SETTINGS = {
  enabled: false,
  errorCodes: [],
  baseCooldownMs: 30000,
  useExponentialBackoff: false,
  maxCooldownMs: 300000
};

export const resolveModelLockoutSettings = () => DEFAULT_MODEL_LOCKOUT_SETTINGS;

const _defaultExport = {};
export default _defaultExport;

