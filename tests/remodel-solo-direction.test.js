import { __setExtensionSettings } from './util/st-context-stub.js';
import { isSoloMode, soloEnvelope } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/solo-direction.js';
import { setLiveDirectionMode } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js';
import { createArc, createScene, createTimeline, getScene } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/timeline-state.js';

beforeEach(() => __setExtensionSettings({ remodel: {} }));

test('isSoloMode is true only when the scene opts in', () => {
    expect(isSoloMode({ liveDirection: { mode: 'solo' } })).toBe(true);
    expect(isSoloMode({ liveDirection: { mode: 'director' } })).toBe(false);
    expect(isSoloMode({ liveDirection: {} })).toBe(false);
    expect(isSoloMode(null)).toBe(false);
});

test('soloEnvelope builds a Director-free envelope that pauses after the turn', () => {
    const snapshot = { mechanics: { addressBook: { entries: [] }, variableRefs: new Map(), goalRefs: new Map() } };
    const { envelope, storedTurn } = soloEnvelope({ id: 's1', timelineId: 't1' }, snapshot, 3);
    expect(storedTurn).toBe(null);
    expect(envelope.reasoning).toBe('');
    expect(envelope.requests).toEqual([]);
    expect(envelope.flow).toEqual({ continueAfter: false, hardPauseAfter: true });
    expect(envelope.notebookTurn).toBe(3);
    expect(envelope.mechanicsSnapshot).toBe(snapshot.mechanics);
    expect(typeof envelope.directionId).toBe('string');
    expect(envelope.directionId.length).toBeGreaterThan(0);
});

test('setLiveDirectionMode persists the chosen mode and rejects an invalid one', () => {
    const timeline = createTimeline('Mode Timeline');
    const arc = createArc(timeline.id, 'Mode Arc');
    const scene = createScene(arc.id, 'roleplay', 'Mode Scene');

    expect(setLiveDirectionMode(scene, 'solo')).toBe(true);
    expect(getScene(scene.id).liveDirection.mode).toBe('solo');

    expect(setLiveDirectionMode(scene, 'director')).toBe(true);
    expect(getScene(scene.id).liveDirection.mode).toBe('director');

    expect(setLiveDirectionMode(scene, 'bogus')).toBe(false);
    expect(getScene(scene.id).liveDirection.mode).toBe('director');
});
