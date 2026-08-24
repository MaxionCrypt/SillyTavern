import { __setExtensionSettings } from './util/st-context-stub.js';
import { createLoomTurnEnvelope, isLoomMode } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/loom-turn.js';
import { setLiveDirectionMode } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js';
import { createArc, createScene, createTimeline, getScene } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/timeline-state.js';

beforeEach(() => __setExtensionSettings({ remodel: {} }));

test('isLoomMode is true only when the scene opts in', () => {
    expect(isLoomMode({ liveDirection: { mode: 'loom' } })).toBe(true);
    expect(isLoomMode({ liveDirection: { mode: 'free' } })).toBe(false);
    expect(isLoomMode({ liveDirection: {} })).toBe(false);
    expect(isLoomMode(null)).toBe(false);
});

test('createLoomTurnEnvelope builds the shared turn envelope', () => {
    const snapshot = {
        mechanics: { addressBook: { entries: [] }, variableRefs: new Map(), goalRefs: new Map() },
        archiveProjection: { version: 1, entries: [{ id: 'evt-1' }] },
    };
    const { envelope, storedTurn } = createLoomTurnEnvelope({ id: 's1', timelineId: 't1' }, snapshot, 3);
    expect(storedTurn).toBe(null);
    expect(envelope.reasoning).toBe('');
    expect(envelope.requests).toEqual([]);
    expect(envelope.flow).toEqual({ continueAfter: false, hardPauseAfter: true });
    expect(envelope.notebookTurn).toBe(3);
    expect(envelope.mechanicsSnapshot).toBe(snapshot.mechanics);
    expect(envelope.archiveProjection).toBe(snapshot.archiveProjection);
    expect(typeof envelope.directionId).toBe('string');
    expect(envelope.directionId.length).toBeGreaterThan(0);
});

test('setLiveDirectionMode accepts only the Loom engine', () => {
    const timeline = createTimeline('Mode Timeline');
    const arc = createArc(timeline.id, 'Mode Arc');
    const scene = createScene(arc.id, 'roleplay', 'Mode Scene');

    // Every directed scene resolves to Loom — the only engine.
    expect(getScene(scene.id).liveDirection.mode).toBe('loom');
    expect(setLiveDirectionMode(scene, 'loom')).toBe(true);
    expect(getScene(scene.id).liveDirection.mode).toBe('loom');

    // The removed legacy engines and anything else are rejected.
    expect(setLiveDirectionMode(scene, 'solo')).toBe(false);
    expect(setLiveDirectionMode(scene, 'bogus')).toBe(false);
    expect(getScene(scene.id).liveDirection.mode).toBe('loom');
});
