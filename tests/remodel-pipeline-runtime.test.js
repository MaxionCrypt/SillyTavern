import { jest } from '@jest/globals';
import {
    createMechanicsExecutor,
    createTurnMechanics,
    createTurnMechanicsForScene,
    isModuleRebuilt,
    isRebuiltMechanicsEnabled,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/pipeline-runtime.js';

const GOALS = [{ title: 'Reach the gate', status: 'active', successRate: 40, holderRefs: [{ id: 'piper' }] }];
const applied = () => ({ ok: true, transaction: { id: 'tx', status: 'applied' }, receipts: [{ status: 'applied', roll: { roll: 9, rate: 40, hit: true } }] });
const REBUILT = { id: 's1', timelineId: 't1', liveDirection: { pipeline: { mechanics: 'rebuilt' } } };

test('the rebuilt mechanics gateway is always on for this branch', () => {
    // This branch exists to run the rebuilt pipeline, so no Scene field turns it
    // off: rolling back is a branch switch, not a runtime toggle.
    expect(isRebuiltMechanicsEnabled(undefined)).toBe(true);
    expect(isRebuiltMechanicsEnabled({})).toBe(true);
    expect(isRebuiltMechanicsEnabled({ liveDirection: { pipeline: { mechanics: 'legacy' } } })).toBe(true);
    expect(isRebuiltMechanicsEnabled(REBUILT)).toBe(true);
});

test('every Scene gets a mechanics dependency, however its fields are set', () => {
    expect(createTurnMechanics({ scene: {} })).not.toBeNull();
    expect(createTurnMechanicsForScene({ scene: { id: 's', timelineId: 't' }, run: {} })).not.toBeNull();
    expect(createTurnMechanicsForScene({ scene: { liveDirection: { pipeline: { mechanics: 'legacy' } } }, run: {} })).not.toBeNull();
});

test('module selection is read per module and defaults to legacy', () => {
    expect(isModuleRebuilt(REBUILT, 'mechanics')).toBe(true);
    expect(isModuleRebuilt(REBUILT, 'narrator-delivery')).toBe(false);
    expect(isModuleRebuilt(undefined, 'mechanics')).toBe(false);
});

test('an opted-in Scene produces an executor and an immutable route receipt', () => {
    const mechanics = createTurnMechanics({
        scene: REBUILT, actor: 'piper', directionId: 'd1', goals: GOALS,
        route: { profileId: 'p1', api: 'openrouter', model: 'z-ai/glm-5.3' },
        execute: applied, listTransactions: () => [],
    });
    expect(typeof mechanics.execute).toBe('function');
    expect(mechanics.route).toMatchObject({ role: 'narrator', model: 'z-ai/glm-5.3', complete: true });
    expect(Object.isFrozen(mechanics.route)).toBe(true);
});

test('an advertised tool call resolves through the actor path', async () => {
    const execute = jest.fn(applied);
    const run = createMechanicsExecutor({
        scene: REBUILT, actor: 'piper', directionId: 'd1', goals: GOALS,
        execute, listTransactions: () => [],
    });
    const receipt = await run({ id: 'c1', name: 'goal.attempt', arguments: { target: 'Reach the gate' } });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(receipt).toMatchObject({ status: 'applied', tool: 'goal.attempt', actor: 'piper', outcome: 'hit' });
});

test('provider tool names in either shape reach the same verb', async () => {
    const execute = jest.fn(applied);
    const run = createMechanicsExecutor({ scene: REBUILT, actor: 'piper', directionId: 'd1', goals: GOALS, execute, listTransactions: () => [] });
    expect(await run({ name: 'goal_attempt', arguments: { target: 'Reach the gate' } })).toMatchObject({ status: 'applied' });
    expect(await run({ name: 'GOAL.ATTEMPT', arguments: { target: 'Reach the gate' } })).toMatchObject({ status: 'applied' });
});

test('a tool outside the advertised vocabulary is rejected, never executed', async () => {
    const execute = jest.fn(applied);
    const run = createMechanicsExecutor({ scene: REBUILT, actor: 'piper', directionId: 'd1', goals: GOALS, execute, listTransactions: () => [] });
    const receipt = await run({ name: 'goal.delete', arguments: { target: 'Reach the gate' } });
    expect(receipt).toMatchObject({ status: 'rejected' });
    expect(execute).not.toHaveBeenCalled();
});

test('a refusal is reported as refused, never as an invented success', async () => {
    const execute = jest.fn(applied);
    const run = createMechanicsExecutor({ scene: REBUILT, actor: 'wren', directionId: 'd1', goals: GOALS, execute, listTransactions: () => [] });
    const receipt = await run({ name: 'goal.attempt', arguments: { target: 'Reach the gate' } });
    expect(receipt).toMatchObject({ status: 'refused' });
    expect(receipt.outcome).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
});

test('each tool call in a turn gets its own attempt index', async () => {
    const seen = [];
    const execute = jest.fn((envelope) => { seen.push(envelope.requests[0].id); return applied(); });
    const run = createMechanicsExecutor({ scene: REBUILT, actor: 'piper', directionId: 'd1', goals: GOALS, execute, listTransactions: () => [] });
    await run({ name: 'goal.attempt', arguments: { target: 'Reach the gate' } });
    await run({ name: 'goal.attempt', arguments: { target: 'Reach the gate' } });
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen[1]).toContain(':1');
});

test('an actor cannot address a secret it does not know', async () => {
    const execute = jest.fn(applied);
    const run = createMechanicsExecutor({
        scene: REBUILT, actor: 'wren', directionId: 'd1', goals: GOALS, execute, listTransactions: () => [],
        secrets: [{ key: 'gate-code', value: '4-1-7' }],
        scopes: [{ key: 'gate-code', authorKnows: true, actors: { piper: 'knows' } }],
    });
    const receipt = await run({ name: 'goal.attempt', arguments: { target: 'Reach the gate' } });
    expect(receipt).toMatchObject({ status: 'refused' });
    expect(execute).not.toHaveBeenCalled();
});
