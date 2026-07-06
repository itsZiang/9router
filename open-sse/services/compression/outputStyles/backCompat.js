/**
 * Resolve the effective output-style selection (D-A5 back-compat).
 * Precedence: an explicit non-empty `outputStyles` wins; otherwise a stored
 * `cavemanOutputMode` (when enabled) maps to `[{ terse-prose, <intensity> }]`,
 * keeping existing installs byte-identical until they opt into other styles.
 * Pure; never throws.
 */
export function resolveOutputStyleSelection(config) {
  if (Array.isArray(config.outputStyles) && config.outputStyles.length > 0) {
    return config.outputStyles;
  }
  const legacy = config.cavemanOutputMode;
  if (legacy?.enabled) {
    return [{
      id: "terse-prose",
      level: legacy.intensity ?? "full"
    }];
  }
  return [];
}