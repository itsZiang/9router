import { deriveDefaultPlan } from "./deriveDefaultPlan";
export function resolveCompressionPlan(config, ctx) {
  if (config?.enabled === false) return {
    mode: "off",
    stackedPipeline: []
  };

  // routing-combo override
  const ov = ctx.comboId ? config?.comboOverrides?.[ctx.comboId] : undefined;
  if (ov) return modeToPlan(ov, config);

  // active named combo
  if (config?.activeComboId && ctx.combos?.[config.activeComboId]) {
    return {
      mode: "stacked",
      stackedPipeline: ctx.combos[config.activeComboId]
    };
  }

  // derived default
  return deriveDefaultPlan(config?.engines ?? {}, config?.enabled !== false);
}
function modeToPlan(mode, config) {
  return mode === "stacked" ? {
    mode: "stacked",
    stackedPipeline: config?.stackedPipeline ?? []
  } : {
    mode,
    stackedPipeline: []
  };
}