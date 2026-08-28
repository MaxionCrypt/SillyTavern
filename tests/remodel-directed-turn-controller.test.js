import { jest } from '@jest/globals';
import fs from 'node:fs';
import { createDirectedTurnController } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/directed-turn-controller.js';

const remodelRoot = '../public/scripts/extensions/third-party/SillyTavern-Remodel';

function makeImplementation(overrides = {}) {
    return {
        initialize: jest.fn(),
        getRun: jest.fn(() => ({
            directionId: 'direction-1',
            sceneId: 'scene-1',
            state: 'Speaking',
            acceptedVisibleText: 'Accepted',
            acceptedComplete: false,
            progress: { id: 'narrator', completed: [] },
        })),
        getUiState: jest.fn(() => ({ active: true, state: 'Speaking', canStop: true })),
        start: jest.fn(async () => 'started'),
        continue: jest.fn(async () => 'continued'),
        retry: jest.fn(async () => 'retried'),
        retryFailure: jest.fn(async () => 'failure-retried'),
        stop: jest.fn(async () => 'stopped'),
        interrupt: jest.fn(() => 'interrupted'),
        editAndRerun: jest.fn(async () => 'rerun'),
        recover: jest.fn(async () => 'recovered'),
        ...overrides,
    };
}

test('requires the complete directed-turn implementation contract', () => {
    expect(() => createDirectedTurnController({})).toThrow(/initialize/);
});

test('routes every lifecycle action through the supplied implementation unchanged', async () => {
    const implementation = makeImplementation();
    const controller = createDirectedTurnController(implementation);
    const scene = { id: 'scene-1' };
    const start = { scene, text: 'Hello', authorizedGoalIds: ['goal-1'] };
    const edit = { scene, messageId: 4, text: 'Changed' };

    await expect(controller.start(start)).resolves.toBe('started');
    await expect(controller.continue(scene)).resolves.toBe('continued');
    await expect(controller.retry(scene)).resolves.toBe('retried');
    await expect(controller.retryFailure()).resolves.toBe('failure-retried');
    await expect(controller.stop()).resolves.toBe('stopped');
    expect(controller.interrupt('typing')).toBe('interrupted');
    await expect(controller.editAndRerun(edit)).resolves.toBe('rerun');
    await expect(controller.recover()).resolves.toBe('recovered');

    expect(implementation.start).toHaveBeenCalledWith(start);
    expect(implementation.continue).toHaveBeenCalledWith(scene);
    expect(implementation.retry).toHaveBeenCalledWith(scene);
    expect(implementation.interrupt).toHaveBeenCalledWith('typing');
    expect(implementation.editAndRerun).toHaveBeenCalledWith(edit);
});

test('publishes detached immutable run and UI snapshots', () => {
    const implementation = makeImplementation();
    const controller = createDirectedTurnController(implementation);
    const snapshot = controller.getSnapshot({ id: 'scene-1' });

    expect(snapshot.run.directionId).toBe('direction-1');
    expect(snapshot.run.acceptedVisibleText).toBe('Accepted');
    expect(snapshot.ui.canStop).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.run.progress)).toBe(true);
    expect(() => { snapshot.run.progress.id = 'changed'; }).toThrow();
    expect(implementation.getRun().progress.id).toBe('narrator');
});

test('keeps state hooks compatible and exposes controller-owned state events', () => {
    const implementation = makeImplementation();
    const controller = createDirectedTurnController(implementation);
    const render = jest.fn();
    const listener = jest.fn();
    controller.subscribe(listener);
    controller.initialize({ getActiveScene: () => ({ id: 'scene-1' }), onStateChange: render });

    const wrappedHooks = implementation.initialize.mock.calls[0][0];
    const legacyRun = { state: 'Directing' };
    wrappedHooks.onStateChange(legacyRun);

    expect(render).toHaveBeenCalledWith(legacyRun);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: 'state' }));
    expect(listener.mock.calls[0][0].snapshot.run.directionId).toBe('direction-1');
});

test('does not translate implementation failures', async () => {
    const failure = new Error('legacy failure');
    const controller = createDirectedTurnController(makeImplementation({ start: jest.fn(async () => { throw failure; }) }));

    await expect(controller.start({ text: 'x' })).rejects.toBe(failure);
});

test('the Roleplay UI reaches lifecycle operations only through the controller', () => {
    const timelineSpine = fs.readFileSync(`${remodelRoot}/timeline-spine.js`, 'utf8');
    const adapter = fs.readFileSync(`${remodelRoot}/legacy-directed-turn-adapter.js`, 'utf8');
    const legacyNames = [
        'initLiveDirection', 'getLiveDirectionRun', 'getLiveDirectionUiState',
        'submitDirectedRoleplay', 'continueLiveStep', 'retryLiveStep',
        'retryLiveDirection', 'stopLiveDirection', 'handleLiveDirectionDraft',
        'rerunDirectedRoleplayFromUserMessage',
    ];

    expect(timelineSpine).toContain("import { directedTurnController } from './legacy-directed-turn-adapter.js';");
    for (const name of legacyNames) {
        expect(timelineSpine).not.toMatch(new RegExp(`\\b${name}\\s*\\(`));
        expect(adapter).toContain(name);
    }
});
