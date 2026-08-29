import {
    CutoverRefused,
    IMPLEMENTATIONS,
    PIPELINE_MODULES,
    createTurnWaterfall,
    describeQueueJob,
    describeSelectedImplementations,
    recordRouteReceipt,
    selectImplementation,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/pipeline-diagnostics.js';

test('every pipeline stage reports which implementation is selected', () => {
    const rows = describeSelectedImplementations({ 'narrator-delivery': 'rebuilt' });
    expect(rows.map((row) => row.module)).toEqual([...PIPELINE_MODULES]);
    expect(rows.find((row) => row.module === 'narrator-delivery').implementation).toBe('rebuilt');
    expect(rows.find((row) => row.module === 'archive-worker').implementation).toBe('legacy');
});

test('an unset or unrecognised module falls back to legacy, never to the experiment', () => {
    const rows = describeSelectedImplementations({ mechanics: 'experimental-v3' });
    expect(rows.find((row) => row.module === 'mechanics').implementation).toBe('legacy');
    expect(describeSelectedImplementations().every((row) => row.implementation === 'legacy')).toBe(true);
    expect(IMPLEMENTATIONS).toEqual(['legacy', 'rebuilt']);
});

test('modules that own prose are marked as such', () => {
    const owners = describeSelectedImplementations().filter((row) => row.ownsProse).map((row) => row.module);
    expect(owners).toEqual(['turn-controller', 'narrator-delivery']);
});

test('a module can be switched module-by-module between turns', () => {
    let selection = selectImplementation({}, 'archive-worker', 'rebuilt');
    selection = selectImplementation(selection, 'narrator-delivery', 'rebuilt');
    expect(selection).toEqual({ 'archive-worker': 'rebuilt', 'narrator-delivery': 'rebuilt' });
});

test('prose ownership cannot be switched while a turn is running', () => {
    expect(() => selectImplementation({}, 'narrator-delivery', 'legacy', { turnActive: true }))
        .toThrow(CutoverRefused);
    expect(() => selectImplementation({}, 'turn-controller', 'rebuilt', { turnActive: true }))
        .toThrow('cannot be switched while a turn is running');
});

test('a module that does not own prose may still be switched mid-turn', () => {
    expect(selectImplementation({}, 'archive-worker', 'rebuilt', { turnActive: true }))
        .toEqual({ 'archive-worker': 'rebuilt' });
    expect(selectImplementation({}, 'scene-council', 'rebuilt', { turnActive: true }))
        .toEqual({ 'scene-council': 'rebuilt' });
});

test('unknown modules and implementations are refused outright', () => {
    expect(() => selectImplementation({}, 'nonsense', 'rebuilt')).toThrow(CutoverRefused);
    expect(() => selectImplementation({}, 'mechanics', 'sideways')).toThrow(CutoverRefused);
});

test('a route receipt is immutable and cannot drift after the turn ran', () => {
    const receipt = recordRouteReceipt({ role: 'narrator', profileId: 'p1', provider: 'openrouter', model: 'z-ai/glm-5.3' });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(() => { 'use strict'; receipt.model = 'something-else'; }).toThrow();
    expect(receipt).toMatchObject({ role: 'narrator', model: 'z-ai/glm-5.3', complete: true });
});

test('a route with no bound model is recorded as incomplete rather than dropped', () => {
    expect(recordRouteReceipt({ role: 'loom', profileId: 'p1' })).toMatchObject({ complete: false });
    expect(recordRouteReceipt({ role: 'loom', model: 'm' })).toMatchObject({ complete: false });
    expect(() => recordRouteReceipt({ profileId: 'p1' })).toThrow('needs a role');
});

test('the waterfall attributes elapsed time per stage, not just a total', () => {
    let clock = 1000;
    const waterfall = createTurnWaterfall({ now: () => clock });
    clock = 1100; waterfall.mark('prompt');
    clock = 1900; waterfall.mark('first-token');
    clock = 2000; waterfall.mark('accepted');
    const report = waterfall.finish();

    expect(report.total).toBe(1000);
    expect(report.stages.map((stage) => stage.stage)).toEqual(['prompt', 'first-token', 'accepted']);
    expect(report.stages[1]).toMatchObject({ at: 900, elapsed: 800 });
    expect(report.slowest.stage).toBe('first-token');
});

test('main-thread responsiveness is counted, not averaged away', () => {
    const waterfall = createTurnWaterfall({ now: () => 0 });
    expect(waterfall.finish().responsive).toBe(true);
    waterfall.recordLongTask(20);
    expect(waterfall.finish().responsive).toBe(true);
    waterfall.recordLongTask(120);
    const report = waterfall.finish();
    expect(report).toMatchObject({ longTasks: 1, responsive: false });
});

test('a queue job reports cause, attempts, and the action that repairs it', () => {
    const job = describeQueueJob({
        jobId: 'job-1', status: 'failed-repairable', attempts: 2,
        error: { message: 'API request failed <- Got response status 400' },
        promptSnapshot: { contentHash: 'a1b2c3d4' }, messageId: 84,
    });
    expect(job).toMatchObject({
        jobId: 'job-1', status: 'failed-repairable', attempts: 2, repair: 'retry', needsAttention: true,
        cause: 'API request failed <- Got response status 400',
    });
    expect(job.acceptedSource).toMatchObject({ contentHash: 'a1b2c3d4', messageId: 84 });
});

test('each failure mode names its own repair action', () => {
    expect(describeQueueJob({ status: 'failed' }).repair).toBe('catch-up');
    expect(describeQueueJob({ status: 'stale' }).repair).toBe('supersede');
    expect(describeQueueJob({ status: 'applied' })).toMatchObject({ repair: '', needsAttention: false });
});
