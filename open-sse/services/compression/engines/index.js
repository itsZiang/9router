import { registerCompressionEngine, getCompressionEngine } from "./registry";
import { aggressiveEngine, cavemanEngine, liteEngine, ultraEngine } from "./cavemanAdapter";
import { rtkEngine } from "./rtk/index";
import { sessionDedupEngine } from "./session-dedup/index";
import { headroomEngine } from "./headroom/index";
import { ccrEngine } from "./ccr/index";
import { llmlinguaEngine } from "./llmlingua/index";
import { ionizerEngine } from "./ionizer/index";
import { relevanceEngine } from "./relevance/index";
import { llmCompressorEngine } from "./llm/index";
import { readLifecycleEngine } from "./readLifecycle/index";
let registered = false;
export function registerBuiltinCompressionEngines() {
  // The `registered` latch is a fast-path to skip the loop, but it must not block
  // re-registration after clearCompressionEngineRegistry() empties the map (tests do this).
  // Re-run when the registry was cleared so the builtins are restored.
  if (registered && getCompressionEngine(liteEngine.id)) return;
  registered = true;
  if (!getCompressionEngine(liteEngine.id)) registerCompressionEngine(liteEngine);
  const engines = [{
    id: "caveman",
    engine: cavemanEngine
  }, {
    id: "aggressive",
    engine: aggressiveEngine
  }, {
    id: "ultra",
    engine: ultraEngine
  }, {
    id: "rtk",
    engine: rtkEngine
  }, {
    id: "session-dedup",
    engine: sessionDedupEngine
  }, {
    id: "headroom",
    engine: headroomEngine
  }, {
    id: "ccr",
    engine: ccrEngine
  }, {
    id: "llmlingua",
    engine: llmlinguaEngine
  }, {
    id: "ionizer",
    engine: ionizerEngine
  }, {
    id: "relevance",
    engine: relevanceEngine
  }, {
    id: "llm",
    engine: llmCompressorEngine
  }, {
    id: "read-lifecycle",
    engine: readLifecycleEngine
  }];
  for (const {
    id,
    engine
  } of engines) {
    if (!getCompressionEngine(id)) registerCompressionEngine(engine);
  }
}