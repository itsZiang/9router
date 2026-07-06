export const ENGINE_CATALOG = {
  "session-dedup": {
    id: "session-dedup",
    label: "Session Dedup",
    stackPriority: 3,
    isSingleMode: false,
    description: "Cross-turn block deduplication."
  },
  ccr: {
    id: "ccr",
    label: "CCR (Retrieval)",
    stackPriority: 4,
    isSingleMode: false,
    description: "Content-addressed retrieval markers."
  },
  lite: {
    id: "lite",
    label: "Lite",
    stackPriority: 5,
    isSingleMode: true,
    description: "Whitespace/format cleanup."
  },
  rtk: {
    id: "rtk",
    label: "RTK",
    stackPriority: 10,
    levels: ["minimal", "standard", "aggressive"],
    isSingleMode: true,
    description: "Command-output filtering."
  },
  headroom: {
    id: "headroom",
    label: "Headroom",
    stackPriority: 15,
    isSingleMode: false,
    description: "Tabular JSON compaction."
  },
  relevance: {
    id: "relevance",
    label: "Relevance",
    stackPriority: 18,
    isSingleMode: true,
    description: "Extractive sentence scoring against the last user query."
  },
  caveman: {
    id: "caveman",
    label: "Caveman",
    stackPriority: 20,
    levels: ["lite", "full", "ultra"],
    isSingleMode: true,
    description: "Rule-based prose compression."
  },
  aggressive: {
    id: "aggressive",
    label: "Aggressive",
    stackPriority: 30,
    isSingleMode: true,
    description: "Summarize + age old turns."
  },
  llmlingua: {
    id: "llmlingua",
    label: "LLMLingua (SLM)",
    stackPriority: 35,
    isSingleMode: false,
    description: "Semantic pruning (ONNX)."
  },
  ultra: {
    id: "ultra",
    label: "Ultra",
    stackPriority: 40,
    isSingleMode: true,
    description: "Heuristic token pruning (+ optional SLM)."
  }
};
export const ENGINE_IDS = Object.values(ENGINE_CATALOG).sort((a, b) => a.stackPriority - b.stackPriority).map(e => e.id);
export function engineMeta(id) {
  return ENGINE_CATALOG[id];
}