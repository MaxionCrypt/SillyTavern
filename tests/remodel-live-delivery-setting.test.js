import { __setExtensionSettings } from './util/st-context-stub.js';
import {
    createArc,
    createScene,
    createTimeline,
    getTimelineStore,
    updateScene,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/timeline-state.js';

beforeEach(() => {
    __setExtensionSettings({});
});

test('new scenes default to the rollback-safe legacy delivery path', () => {
    const timeline = createTimeline('Delivery test');
    const arc = createArc(timeline.id, 'Arc');
    const scene = createScene(arc.id, 'Scene', 'roleplay');

    expect(scene.liveDirection.delivery).toBe('legacy');
});

test('canonical delivery persists through store normalization and rejects unknown modes', () => {
    const timeline = createTimeline('Delivery test');
    const arc = createArc(timeline.id, 'Arc');
    const scene = createScene(arc.id, 'Scene', 'roleplay');

    updateScene(scene.id, { liveDirection: { ...scene.liveDirection, delivery: 'canonical' } });
    expect(getTimelineStore().scenes[scene.id].liveDirection.delivery).toBe('canonical');

    updateScene(scene.id, { liveDirection: { ...scene.liveDirection, delivery: 'unknown' } });
    expect(getTimelineStore().scenes[scene.id].liveDirection.delivery).toBe('legacy');
});
