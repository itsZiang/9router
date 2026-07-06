import { getLogger } from "log-wrapper";
export function recordComboIntentWithSpecificity(comboName, specificityScore, specificityLevel, strategyModifier) {
  getLogger().info({
    comboName,
    specificityScore,
    specificityLevel,
    strategyModifier
  }, "combo manifest routing applied");
}