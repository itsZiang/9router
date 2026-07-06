/**
 * Tokens-per-task gate (N4). The harness measures the average compressed token
 * cost per task group; this gate fails when that cost *rises* versus a frozen
 * baseline beyond a tolerance — i.e. a change made the pipeline compress worse.
 * Falling cost (better compression) always passes; the baseline is updated
 * deliberately, like the project's other ratchets.
 */

/** Mean compressed tokens per task group in a report. */
export function tokensPerTask(report) {
  const byTask = new Map();
  for (const r of report.results) {
    const entry = byTask.get(r.task) ?? {
      tokens: 0,
      count: 0
    };
    entry.tokens += r.compressedTokens;
    entry.count += 1;
    byTask.set(r.task, entry);
  }
  const out = {};
  for (const [task, {
    tokens,
    count
  }] of byTask) {
    out[task] = Math.round(tokens / count);
  }
  return out;
}
export function checkTokensPerTaskGate(report, baseline, tolerancePercent = 2) {
  const current = tokensPerTask(report);
  const regressions = [];
  for (const [task, base] of Object.entries(baseline.tasks)) {
    const cur = current[task];
    if (cur === undefined || base <= 0) continue;
    const deltaPercent = Math.round((cur - base) / base * 1000) / 10;
    if (deltaPercent > tolerancePercent) {
      regressions.push({
        task,
        baseline: base,
        current: cur,
        deltaPercent
      });
    }
  }
  return {
    passed: regressions.length === 0,
    regressions,
    tolerancePercent
  };
}