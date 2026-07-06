// Auto-generated stub: stubs/lib/resilience/settings
export const DEFAULT_RESILIENCE_SETTINGS = {
  providerCooldown: {
    enabled: false,
    minRetryCooldownMs: 1000,
    maxRetryCooldownMs: 60000,
  },
  requestQueue: {
    enabled: false
  },
  comboCooldownWait: {
    enabled: false,
    budgetMs: 0,
    maxAttempts: 1
  },
  quotaShareConcurrencyLimit: {
    enabled: false
  },
  quotaPreflight: {
    enabled: false
  },
  streamRecovery: {
    enabled: false,
    continueMidStream: false
  },
  connectionCooldown: {
    oauth: {
      baseCooldownMs: 1000,
      useUpstreamRetryHints: true,
      useUpstream429BreakerHints: true,
      maxBackoffSteps: 5
    },
    apikey: {
      baseCooldownMs: 1000,
      useUpstreamRetryHints: true,
      useUpstream429BreakerHints: true,
      maxBackoffSteps: 5
    }
  },
  providerBreaker: {
    oauth: {
      failureThreshold: 5,
      resetTimeoutMs: 30000,
      degradationThreshold: 0.5
    },
    apikey: {
      failureThreshold: 5,
      resetTimeoutMs: 30000,
      degradationThreshold: 0.5
    }
  }
};

export const isStreamRecoveryExplicitlyConfigured = () => false;
export const resolveResilienceSettings = (settings) => DEFAULT_RESILIENCE_SETTINGS;

const _defaultExport = {};
export default _defaultExport;

