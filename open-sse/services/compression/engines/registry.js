const ENGINES = new Map();
function assertValidEngine(engine) {
  if (!engine?.id || typeof engine.apply !== "function" || typeof engine.compress !== "function" || typeof engine.getConfigSchema !== "function" || typeof engine.validateConfig !== "function") {
    throw new Error("Invalid compression engine registration");
  }
}
export function registerEngine(engine, defaultConfig = {}) {
  assertValidEngine(engine);
  const validation = engine.validateConfig(defaultConfig);
  if (!validation.valid) {
    throw new Error(`Invalid default config for ${engine.id}: ${validation.errors.join("; ")}`);
  }
  ENGINES.set(engine.id, {
    engine,
    enabled: true,
    config: {
      ...defaultConfig
    }
  });
}
export function registerCompressionEngine(engine) {
  registerEngine(engine);
}
export function unregisterCompressionEngine(id) {
  return ENGINES.delete(id);
}
export function getEngine(id) {
  return ENGINES.get(id)?.engine ?? null;
}
export function getCompressionEngine(id) {
  return getEngine(id);
}
export function getEngineEntry(id) {
  return ENGINES.get(id) ?? null;
}
export function listEngines() {
  return Array.from(ENGINES.values());
}
export function listCompressionEngines() {
  return listEngines().map(entry => entry.engine);
}
export function listEnabledEngines() {
  return listEngines().filter(entry => entry.enabled);
}
export function setEngineEnabled(id, enabled) {
  const entry = ENGINES.get(id);
  if (!entry) return false;
  entry.enabled = enabled;
  return true;
}
export function updateEngineConfig(id, config) {
  const entry = ENGINES.get(id);
  if (!entry) return {
    valid: false,
    errors: [`Unknown compression engine: ${id}`]
  };
  const nextConfig = {
    ...entry.config,
    ...config
  };
  const validation = entry.engine.validateConfig(nextConfig);
  if (!validation.valid) return validation;
  entry.config = nextConfig;
  return {
    valid: true,
    errors: []
  };
}
export function clearCompressionEngineRegistry() {
  ENGINES.clear();
}