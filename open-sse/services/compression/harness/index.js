/**
 * Compression eval/benchmark harness (F0.3 — C1 + N4 gate + TV3 replay).
 *
 * API-free, CI-safe primitives to answer "did meaning survive?" (retention) and
 * "did cost/task get worse?" (budget gate), plus a replay path over real
 * transcripts. Engines and the studios consume these to keep compression honest.
 */
export { extractEntities, computeRetention, measureCompression } from "./measure";
export { runCompressionEval } from "./runner";
export { tokensPerTask, checkTokensPerTaskGate } from "./budgetGate";
export { transcriptsToCorpus, replayTranscripts, requestBodyToTranscript, requestBodiesToTranscripts } from "./replay";
export { BENCHMARK_CORPUS, DEFAULT_BENCHMARK_ENGINES, engineToCompressFn, benchmarkEngines, compareReports, runBenchmarkGate, formatBenchmarkTable } from "./benchmark";