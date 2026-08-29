// Commit 16 validation: cross-module audits of the rebuilt Narrator authority
// pipeline, plus the acceptance-threshold and decision machinery.
//
// Scope boundary, stated plainly: the rebuilt modules are closed units with no
// production callers yet, so the end-to-end journeys the plan lists (long
// Roleplay, reload, navigation restore, live provider failure) cannot be driven
// from here. What IS auditable at the seam is covered: exact-once across
// retry/regenerate/reload, rollback, backlog ordering, cross-Scene
// independence, knowledge non-leak, and prose-ownership safety.
import { jest } from '@jest/globals';
import { freezeMechanicsAttempt, resolveMechanicsAttempt } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/mechanics-gateway.js';
import { resolveActorAttempt } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/actor-mechanics.js';
import { findKnowledgeLeaks, projectActorKnowledge } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/knowledge-scopes.js';
import { CutoverRefused, selectImplementation } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/pipeline-diagnostics.js';
import {
    ACCEPTANCE_THRESHOLDS,
    EvaluationRefused,
    compareRuns,
    evaluateThresholds,
    recordEvaluation,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/pipeline-evaluation.js';

const GOALS = [{ title: 'Reach the gate', status: 'active', successRate: 40, holderRefs: [{ id: 'piper' }] }];
const applied = () => ({ ok: true, transaction: { id: 'tx', status: 'applied' }, receipts: [{ status: 'applied', roll: { roll: 9, rate: 40, hit: true } }] });

const PASSING = {
    firstTokenBlockedBy: 'narrator', synchronousLoomWaitMs: 0, proseRewrites: 0, unsettledTurns: 0,
    maxQueueDepth: 2, queueDepthBound: 5, duplicateApplications: 0, unreversedRollbacks: 0,
    actorChosenOutcomes: 0, timelineGrowth: 120, baselineTimelineGrowth: 100,
    warmCouncilTtftDeltaMs: 0, ttftDeltaToleranceMs: 0, hallucinatedMechanics: 0, legacySwitchBackWorks: true,
};

// ---------------------------------------------------------------- audits ---

test('a Retry of the same turn applies once and replays its receipt', () => {
    const execute = jest.fn(applied);
    const frozen = freezeMechanicsAttempt({ tool: 'goal.attempt', actor: 'piper', target: 'Reach the gate', directionId: 'd1', odds: 40 });
    const committed = [];
    const listTransactions = () => committed;

    const first = resolveMechanicsAttempt(frozen, { execute, listTransactions });
    committed.push({ status: 'applied', source: { attemptKey: frozen.attemptKey }, receipts: [{ status: 'applied', roll: { roll: 9, hit: true } }] });
    const retried = resolveMechanicsAttempt(frozen, { execute, listTransactions });

    expect(first.reused).toBe(false);
    expect(retried.reused).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
});

test('a regenerate or provider reconnect within the same direction cannot double-apply', () => {
    const execute = jest.fn(applied);
    const committed = [{ status: 'applied', source: { attemptKey: 'd1:piper:goal.attempt:Reach the gate:0' }, receipts: [{ status: 'applied' }] }];
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const frozen = freezeMechanicsAttempt({ tool: 'goal.attempt', actor: 'piper', target: 'Reach the gate', directionId: 'd1', odds: 40 });
        resolveMechanicsAttempt(frozen, { execute, listTransactions: () => committed });
    }
    expect(execute).not.toHaveBeenCalled();
});

test('a rolled-back transaction leaves the attempt genuinely un-applied', () => {
    const execute = jest.fn(applied);
    const rolledBack = [{ status: 'rolled-back', source: { attemptKey: 'd1:piper:goal.attempt:Reach the gate:0' }, receipts: [] }];
    const frozen = freezeMechanicsAttempt({ tool: 'goal.attempt', actor: 'piper', target: 'Reach the gate', directionId: 'd1', odds: 40 });
    resolveMechanicsAttempt(frozen, { execute, listTransactions: () => rolledBack });
    expect(execute).toHaveBeenCalledTimes(1);
});

test('an edit that starts a new direction is new work, not a replay', () => {
    const execute = jest.fn(applied);
    const committed = [{ status: 'applied', source: { attemptKey: 'd1:piper:goal.attempt:Reach the gate:0' }, receipts: [{ status: 'applied' }] }];
    const rerun = freezeMechanicsAttempt({ tool: 'goal.attempt', actor: 'piper', target: 'Reach the gate', directionId: 'd2', odds: 40 });
    resolveMechanicsAttempt(rerun, { execute, listTransactions: () => committed });
    expect(execute).toHaveBeenCalledTimes(1);
});

test('the same actor and Goal in a different Scene are independent attempts', () => {
    const a = freezeMechanicsAttempt({ tool: 'goal.attempt', actor: 'piper', target: 'Reach the gate', directionId: 'scene-a-turn-1', odds: 40 });
    const b = freezeMechanicsAttempt({ tool: 'goal.attempt', actor: 'piper', target: 'Reach the gate', directionId: 'scene-b-turn-1', odds: 40 });
    expect(a.attemptKey).not.toBe(b.attemptKey);
});

test('an AI actor cannot choose its own outcome', () => {
    const execute = jest.fn(() => ({ ok: true, transaction: {}, receipts: [{ status: 'applied', roll: { roll: 97, rate: 40, hit: false } }] }));
    const result = resolveActorAttempt({
        actor: 'piper', tool: 'goal.attempt', target: 'Reach the gate', directionId: 'd1',
        goals: GOALS, execute, listTransactions: () => [],
    });
    // The engine's roll stands even though the actor initiated the attempt.
    expect(result.receipt.outcome).toBe('miss');
    expect(execute.mock.calls[0][0].requests[0].arguments).toEqual({ goalRef: 'Reach the gate' });
});

test('background ingestion text is auditable for author-only leaks', () => {
    const secrets = [{ key: 'k', value: 'The gate code is 4-1-7.' }];
    const scopes = [{ key: 'k', authorKnows: true, actors: { piper: 'knows' } }];
    expect(projectActorKnowledge({ secrets, scopes, actor: 'wren' }).items).toEqual([]);
    expect(findKnowledgeLeaks('Wren muttered: The gate code is 4-1-7.', { secrets, scopes, actor: 'wren' }))
        .toEqual(['The gate code is 4-1-7.']);
});

test('prose ownership cannot change mid-turn during a fallback', () => {
    expect(() => selectImplementation({}, 'narrator-delivery', 'legacy', { turnActive: true })).toThrow(CutoverRefused);
    expect(selectImplementation({}, 'archive-worker', 'legacy', { turnActive: true })).toEqual({ 'archive-worker': 'legacy' });
});

// ----------------------------------------------------------- thresholds ---

test('every §11 acceptance threshold is represented and checkable', () => {
    expect(ACCEPTANCE_THRESHOLDS).toHaveLength(11);
    expect(evaluateThresholds(PASSING).passed).toBe(true);
});

test('an unmeasured threshold reads as failure, never as a pass', () => {
    const evaluation = evaluateThresholds({});
    expect(evaluation.passed).toBe(false);
    expect(evaluation.failed).toContain('narrator-gated-first-token');
    expect(evaluation.failed).toContain('legacy-switch-back-intact');
});

test('each broken promise is named individually', () => {
    expect(evaluateThresholds({ ...PASSING, proseRewrites: 1 }).failed).toEqual(['prose-never-rewritten']);
    expect(evaluateThresholds({ ...PASSING, duplicateApplications: 1 }).failed).toEqual(['receipts-exact-once']);
    expect(evaluateThresholds({ ...PASSING, maxQueueDepth: 9 }).failed).toEqual(['bounded-queue-lag']);
});

test('a partial comparison is reported as incomplete rather than as a result', () => {
    expect(compareRuns({ p50TtftMs: 900 }, { p50TtftMs: 400 })).toMatchObject({ measuredCount: 1, complete: false });
    const full = {
        p50TtftMs: 1, p95TtftMs: 1, visibleCompletionMs: 1, readyForNextTurnMs: 1, archiveLagMs: 1,
        tokens: 1, correctionRate: 1, inputLatencyMs: 1, longTasks: 1, memoryMb: 1,
    };
    expect(compareRuns(full, full).complete).toBe(true);
    expect(compareRuns({ p50TtftMs: 900 }, { p50TtftMs: 400 }).deltas.p50TtftMs)
        .toMatchObject({ delta: -500, improved: true });
});

test('the verdict must be stated, never derived from good numbers', () => {
    expect(() => recordEvaluation({ metrics: PASSING, rationale: 'looks fine' })).toThrow(EvaluationRefused);
    expect(() => recordEvaluation({ verdict: 'probably-fine', metrics: PASSING, rationale: 'x' })).toThrow(EvaluationRefused);
    expect(() => recordEvaluation({ verdict: 'keep', metrics: PASSING })).toThrow('rationale');
});

test('the experiment cannot be kept over a threshold it did not meet', () => {
    expect(() => recordEvaluation({ verdict: 'keep', metrics: { ...PASSING, proseRewrites: 2 }, rationale: 'ship it' }))
        .toThrow('Cannot keep: unmet thresholds — prose-never-rewritten');
    // rework and reject stay available regardless of the numbers.
    expect(recordEvaluation({ verdict: 'rework', metrics: {}, rationale: 'TTFT regressed' })).toMatchObject({ verdict: 'rework' });
});

test('keeping the experiment does not authorise removing legacy', () => {
    const decision = recordEvaluation({ verdict: 'keep', metrics: PASSING, rationale: 'Sustained live use over a week.' });
    expect(decision).toMatchObject({ verdict: 'keep', legacyRemovalAuthorised: false });
});
