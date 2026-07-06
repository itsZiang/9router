import { NO_RENDER } from "./types";
import { renderGitDiff } from "./gitDiff";
import { renderTestGreen } from "./testGreen";
import { renderTerraformPlan } from "./terraformPlan";
import { renderStructuredTable } from "./structuredTable";

// preenchido nas tasks 2–5
const REGISTRY = {};

// Task 2: git-diff renderer
// Note: "git-show" is not a real detection type in commandDetector.ts DETECTORS array,
// so only "git-diff" is registered here.
REGISTRY["git-diff"] = renderGitDiff;

// Task 3: test-green renderer
// Note: "test-eslint" is not a real detection type; the real type is "build-eslint".
REGISTRY["test-pytest"] = renderTestGreen;
REGISTRY["test-jest"] = renderTestGreen;
REGISTRY["test-vitest"] = renderTestGreen;
REGISTRY["build-eslint"] = renderTestGreen;

// Task 4: terraform-plan renderer
REGISTRY["terraform-plan"] = renderTerraformPlan;
REGISTRY["tofu-plan"] = renderTerraformPlan;

// Task 5: structured-table renderer
// Note: "kubectl" is not a real detection type in commandDetector.ts DETECTORS array
// (it's in KNOWN_COMMANDS but has no DETECTOR entry with a "kubectl" type).
// Kubectl JSON output will be detected as "json-output" or "aws" depending on content.
// Registering "aws" and "json-output" which are the real types for this output shape.
REGISTRY["aws"] = renderStructuredTable;
REGISTRY["json-output"] = renderStructuredTable;
export function applyRenderer(text, detection, config) {
  const r = REGISTRY[detection.type];
  if (!r) return NO_RENDER(text);
  if (config.renderers && config.renderers.length > 0 && !config.renderers.includes(detection.type)) {
    return NO_RENDER(text);
  }
  return r(text, detection);
}
export { REGISTRY };