// Evaluation of the rebuilt Narrator authority pipeline.
//
// The experiment's acceptance conditions were written down before it started
// (plan §11). This turns them into predicates that can be checked against
// measured runs, so "is it better?" is answered by the thresholds that were
// agreed in advance rather than by whichever number looks good afterwards.
//
// It deliberately cannot decide. `recordEvaluation` refuses to invent a verdict
// from passing numbers: the plan requires an explicit keep/rework/reject, made
// by the owner after sustained live use, and legacy code is removed only in a
// later cleanup commit once that verdict is `keep`.

export const EVALUATION_VERDICTS = Object.freeze(['keep', 'rework', 'reject']);

/**
 * The §11 thresholds. Each is a named predicate over one measured run so a
 * failure says which promise broke, not merely that something did.
 */
export const ACCEPTANCE_THRESHOLDS = Object.freeze([
    Object.freeze({ id: 'narrator-gated-first-token', describe: 'first visible character is gated by the Narrator only', check: (m) => m.firstTokenBlockedBy === 'narrator' }),
    Object.freeze({ id: 'no-synchronous-loom-wait', describe: 'ordinary turns incur no synchronous Loom wait', check: (m) => Number(m.synchronousLoomWaitMs || 0) === 0 }),
    Object.freeze({ id: 'prose-never-rewritten', describe: 'no accepted prose disappears, restarts, or changes after display', check: (m) => Number(m.proseRewrites || 0) === 0 }),
    Object.freeze({ id: 'every-turn-settles', describe: 'every accepted turn reaches an applied or explicitly failed Archive job', check: (m) => Number(m.unsettledTurns || 0) === 0 }),
    Object.freeze({ id: 'bounded-queue-lag', describe: 'queue lag stays bounded under repeated Continue', check: (m) => Number(m.maxQueueDepth || 0) <= Number(m.queueDepthBound ?? 5) }),
    Object.freeze({ id: 'receipts-exact-once', describe: 'mechanics receipts are deterministic, exact-once, reversible, and obeyed', check: (m) => Number(m.duplicateApplications || 0) === 0 && Number(m.unreversedRollbacks || 0) === 0 }),
    Object.freeze({ id: 'actors-cannot-choose-outcome', describe: 'AI actors initiate without controlling the result', check: (m) => Number(m.actorChosenOutcomes || 0) === 0 }),
    Object.freeze({ id: 'timeline-growth-parity', describe: 'Timeline Web growth is at least the recorded baseline', check: (m) => Number(m.timelineGrowth || 0) >= Number(m.baselineTimelineGrowth || 0) }),
    Object.freeze({ id: 'council-does-not-cost-ttft', describe: 'Scene Council prefetch does not measurably worsen Send latency when warm', check: (m) => Number(m.warmCouncilTtftDeltaMs || 0) <= Number(m.ttftDeltaToleranceMs ?? 0) }),
    Object.freeze({ id: 'explicit-provider-degradation', describe: 'unsupported providers degrade explicitly rather than hallucinating mechanics', check: (m) => Number(m.hallucinatedMechanics || 0) === 0 }),
    Object.freeze({ id: 'legacy-switch-back-intact', describe: 'the legacy pipeline remains a clean switch-back path', check: (m) => m.legacySwitchBackWorks === true }),
]);

/** Check one measured run against every threshold. */
export function evaluateThresholds(metrics = {}) {
    const results = ACCEPTANCE_THRESHOLDS.map((threshold) => Object.freeze({
        id: threshold.id,
        describe: threshold.describe,
        // An unmeasured threshold is not a passing one. Silence is the most
        // common way a gate gets skipped, so it reads as failure here.
        measured: threshold.check(metrics) === true,
    }));
    const failed = results.filter((item) => !item.measured);
    return Object.freeze({
        results: Object.freeze(results),
        passed: failed.length === 0,
        failed: Object.freeze(failed.map((item) => item.id)),
    });
}

/**
 * Compare legacy against rebuilt on the measures the plan named. Returns deltas
 * only — no verdict. A faster p50 with a worse p95 is a judgement call, and
 * this module does not get to make it.
 */
export function compareRuns(legacy = {}, rebuilt = {}) {
    const keys = ['p50TtftMs', 'p95TtftMs', 'visibleCompletionMs', 'readyForNextTurnMs', 'archiveLagMs', 'tokens', 'correctionRate', 'inputLatencyMs', 'longTasks', 'memoryMb'];
    const deltas = {};
    for (const key of keys) {
        const before = Number(legacy?.[key]);
        const after = Number(rebuilt?.[key]);
        deltas[key] = Number.isFinite(before) && Number.isFinite(after)
            ? Object.freeze({ legacy: before, rebuilt: after, delta: after - before, improved: after <= before })
            : null;
    }
    const compared = Object.values(deltas).filter(Boolean);
    return Object.freeze({
        deltas: Object.freeze(deltas),
        measuredCount: compared.length,
        // Absent measurements are absent, not neutral: a comparison over two of
        // ten measures is not a comparison of the pipeline.
        complete: compared.length === keys.length,
    });
}

export class EvaluationRefused extends Error {}

/**
 * Record the explicit decision. Refuses to be derived: the verdict must be
 * supplied, and `keep` additionally requires that every threshold was met, so
 * the experiment cannot be accepted over a promise it did not deliver.
 */
export function recordEvaluation({ verdict, metrics = {}, comparison = null, rationale = '', at = null } = {}) {
    if (!EVALUATION_VERDICTS.includes(verdict)) {
        throw new EvaluationRefused(`An explicit verdict is required: ${EVALUATION_VERDICTS.join(', ')}.`);
    }
    const thresholds = evaluateThresholds(metrics);
    if (verdict === 'keep' && !thresholds.passed) {
        throw new EvaluationRefused(`Cannot keep: unmet thresholds — ${thresholds.failed.join(', ')}.`);
    }
    if (!String(rationale || '').trim()) throw new EvaluationRefused('A decision needs a stated rationale.');
    return Object.freeze({
        verdict,
        rationale: String(rationale),
        thresholds,
        comparison,
        at,
        // Removing legacy is a separate, later act even after `keep`.
        legacyRemovalAuthorised: false,
    });
}
