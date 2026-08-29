import { jest } from '@jest/globals';
import { createArchiveSettlementEvent } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/archive-consequences.js';
import {
    buildTimelineLifecyclePromptGuide,
    selectTimelineLifecycleProposals,
    validateTimelineLifecycleProposal,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/timeline-lifecycle-contract.js';
import {
    createTimelineLifecycleProjector,
    getTimelineLifecycleProjectionSwitches,
    setTimelineLifecycleProjectionSwitch,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/timeline-lifecycle-projection.js';
import { createTimelineGoal, getStoryGoal, getTimelineGoals } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/story-goals-store.js';
import { listMechanicsTransactions, listVariableValues } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/variables-store.js';
import { undoMechanicsTransaction } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/mechanics-capabilities.js';
import { __setExtensionSettings } from './util/st-context-stub.js';

const TIMELINE = 'timeline-lifecycle-1';
const SCENE = 'scene-lifecycle-1';

beforeEach(() => {
    __setExtensionSettings({ remodel: {} });
});

function event(lifecycleProposals, overrides = {}) {
    return createArchiveSettlementEvent({
        jobId: 'archive:turn-1', timelineId: TIMELINE, sceneId: SCENE, mode: 'roleplay',
        acceptedProse: 'Wren barred the gate and swore to hold it until dawn.',
        provenance: { sourceId: 'turn-1', messageId: 7, checkpointId: 'accepted' },
        operations: [{ id: 'e1', capability: 'event.record', arguments: { summary: 'Wren barred the gate.' }, reason: 'accepted prose' }],
        lifecycleProposals,
        archiveFacts: ['Wren barred the gate.'], transactionId: 'archive-tx-1',
        ...overrides,
    }, () => 42);
}

function request(id, capability, args, reason = 'Accepted prose establishes this lifecycle change.') {
    return { id, capability, arguments: args, reason };
}

test('the lifecycle vocabulary excludes rolls and existing numeric value changes', () => {
    const proposals = selectTimelineLifecycleProposals([
        request('g1', 'goal.create', {}),
        request('r1', 'goal.reach', { goalRef: 'Hold' }),
        request('v1', 'variable.create', {}),
        request('v2', 'variable.adjust', { variableRef: 'Alarm', delta: 2 }),
    ]);
    expect(proposals.map((item) => item.capability)).toEqual(['goal.create', 'variable.create']);
    const guide = buildTimelineLifecyclePromptGuide({ goals: true, variables: true });
    expect(guide).toContain('Do not roll');
    expect(guide).toContain('[{"kind":"character","id":"<cast name>","label":"<cast name>"}]');
});

test('background Goal edits cannot smuggle odds changes or reopen a closed Goal', () => {
    expect(validateTimelineLifecycleProposal(request('g1', 'goal.edit', { goalRef: 'Hold', successRate: 90 }), 'goals')).toMatchObject({ ok: false, code: 'unsupported-numeric-change' });
    expect(validateTimelineLifecycleProposal(request('g2', 'goal.edit', { goalRef: 'Hold', status: 'active' }), 'goals')).toMatchObject({ ok: false, code: 'unsupported-goal-transition' });
    expect(validateTimelineLifecycleProposal(request('g3', 'goal.create', { title: 'Hold', description: 'Keep holding.', holderRefs: [], visibility: 'private' }), 'goals')).toMatchObject({ ok: false, code: 'unsupported-goal-visibility' });
});

test('world Goals can be created, related, and closed through deterministic mechanics receipts', () => {
    const projector = createTimelineLifecycleProjector();
    const created = projector.project('goals', event([
        request('g1', 'goal.create', { alias: 'hold', title: 'Hold the gate', description: 'Keep the gate barred until dawn.', holderRefs: [{ kind: 'character', id: 'wren', label: 'Wren' }] }),
        request('g2', 'goal.create', { alias: 'breach', title: 'Breach the gate', description: 'Open the gate before dawn.', holderRefs: [{ kind: 'faction', id: 'raiders', label: 'Raiders' }] }),
        request('g3', 'goal.relate', { fromGoalRef: '$breach', toGoalRef: '$hold', type: 'antagonistic' }),
    ]));
    expect(created).toMatchObject({ status: 'applied', applied: 3, rollback: { kind: 'mechanics-transaction', ownsBaseArchive: false } });
    const goals = getTimelineGoals(TIMELINE);
    expect(goals.map((goal) => goal.title).sort()).toEqual(['Breach the gate', 'Hold the gate']);
    expect(goals.every((goal) => goal.successRate === 30)).toBe(true);

    const closed = projector.project('goals', event([
        request('g4', 'goal.edit', { goalRef: 'Hold the gate', status: 'achieved', description: 'The gate remained barred through dawn.' }),
    ], { jobId: 'archive:turn-2', acceptedProse: 'Dawn broke over a gate that remained barred.' }));
    expect(closed.status).toBe('applied');
    expect(getTimelineGoals(TIMELINE).find((goal) => goal.title === 'Hold the gate').status).toBe('achieved');
});

test('persona-owned Goal lifecycle changes remain pending for user review', () => {
    const goal = createTimelineGoal(TIMELINE, {
        title: 'Escape unseen', description: 'Leave without being identified.',
        holderRefs: [{ kind: 'persona', id: 'aiden', label: 'Aiden' }], successRate: 55,
    }, { sceneId: SCENE });
    const receipt = createTimelineLifecycleProjector().project('goals', event([
        request('g1', 'goal.edit', { goalRef: 'Escape unseen', status: 'achieved' }),
    ]));
    expect(receipt).toMatchObject({ status: 'pending', applied: 0, pendingReview: 1 });
    expect(getStoryGoal(goal.id).status).toBe('active');
});

test('Variable creation is additive, review-owned, and cannot alter existing values', () => {
    const projector = createTimelineLifecycleProjector();
    const receipt = projector.project('variables', event([
        request('v1', 'variable.create', {
            name: 'Gate alarm', description: 'The defenders current alert state.',
            valueType: 'enum', value: 'raised', enumValues: ['quiet', 'raised', 'general alarm'],
        }),
        request('v2', 'variable.adjust', { variableRef: 'Gate alarm', delta: 2 }),
    ]));
    expect(receipt).toMatchObject({ status: 'applied', applied: 1 });
    const variable = listVariableValues({ timelineId: TIMELINE })[0];
    expect(variable).toMatchObject({ name: 'Gate alarm', value: 'raised', authority: 'review' });
});

test('projection transactions preserve exact Archive provenance and have an independent rollback receipt', () => {
    const receipt = createTimelineLifecycleProjector().project('goals', event([
        request('g1', 'goal.create', { title: 'Hold the gate', description: 'Keep it barred.', holderRefs: [{ kind: 'character', id: 'wren', label: 'Wren' }] }),
    ]));
    const transaction = listMechanicsTransactions({ timelineId: TIMELINE }).find((item) => item.id === receipt.transactionId);
    expect(transaction.source).toMatchObject({
        kind: 'archive-lifecycle-projection', eventId: 'archive-settlement:archive:turn-1',
        archiveJobId: 'archive:turn-1', archiveTransactionId: 'archive-tx-1',
    });
    expect(transaction.receipts[0].validatedInputs._archiveEvidence).toMatchObject({
        eventId: 'archive-settlement:archive:turn-1', jobId: 'archive:turn-1', sourceId: 'turn-1',
    });
    expect(undoMechanicsTransaction(transaction)).toBe(true);
    expect(getTimelineGoals(TIMELINE)).toEqual([]);
});

test('Goal and Variable projection switches are independently persisted', () => {
    expect(getTimelineLifecycleProjectionSwitches()).toEqual({ goals: true, variables: true });
    expect(setTimelineLifecycleProjectionSwitch('goals', false)).toEqual({ goals: false, variables: true });
    expect(setTimelineLifecycleProjectionSwitch('variables', false)).toEqual({ goals: false, variables: false });
});

test('a rolled-back lifecycle batch reports failure without touching the base Archive authority', () => {
    const execute = jest.fn(() => ({ ok: false, transaction: { id: 'lifecycle-tx', status: 'rolled-back' }, receipts: [{ status: 'rejected' }], errors: ['bad ref'] }));
    const receipt = createTimelineLifecycleProjector({ execute }).project('goals', event([
        request('g1', 'goal.edit', { goalRef: 'Missing goal', status: 'abandoned' }),
    ]));
    expect(receipt).toMatchObject({ status: 'rolled-back', transactionId: 'lifecycle-tx', rollback: null });
    expect(event([]).baseArchive).toEqual({ status: 'applied', transactionId: 'archive-tx-1' });
});
