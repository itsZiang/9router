/**
 * ComboContext — the per-request mutable carrier for the combo dispatch pipeline
 * (Quality Gate v2 / Fase 9 — god-file decomposition, fase 1).
 *
 * handleComboChat in combo.ts is a ~1600-LOC orchestrator whose phases share a set of
 * "dispatch frontier" locals — chief among them the request `body`, which the setup phase
 * rewrites (context-cache pinning + combo agent middleware) and later dispatch phases keep
 * sharing. Carrying that mutable state on a single ctx object lets each phase be extracted
 * into a small, independently testable/mutatable function instead of living inside the
 * monolith. This is the first extracted slice; subsequent phases will add their own shared
 * mutable fields (executor, runUpstreamStream, semaphore, retry accumulators) to ComboContext.
 *
 * See _tasks/quality/2026-06-19-DESIGN-godfiles-decomposition.md §4.
 */

export function createComboContext(opts) {
  // body is carried by reference (not copied) so phaseComboSetup's reassignments are
  // byte-identical to the original inline code: it only ever replaces ctx.body with a NEW
  // object on a pin ({ ...body, model }) or via the middleware result, never mutates in place.
  return {
    body: opts.body,
    combo: opts.combo,
    settings: opts.settings ?? null,
    relayOptions: opts.relayOptions ?? null,
    log: opts.log
  };
}