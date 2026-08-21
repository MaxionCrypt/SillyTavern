import { __setExtensionSettings } from './util/st-context-stub.js';
import { isEditorMode } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/director-editor.js';
import { setLiveDirectionMode } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js';
import { createArc, createScene, createTimeline, getScene } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/timeline-state.js';

beforeEach(() => __setExtensionSettings({ remodel: {} }));

test('isEditorMode is true only for the editor mode', () => {
    expect(isEditorMode({ liveDirection: { mode: 'editor' } })).toBe(true);
    expect(isEditorMode({ liveDirection: { mode: 'solo' } })).toBe(false);
    expect(isEditorMode({ liveDirection: {} })).toBe(false);
    expect(isEditorMode(null)).toBe(false);
});

test('setLiveDirectionMode accepts editor alongside director and solo', () => {
    const scene = createScene(createArc(createTimeline('T').id, 'A').id, 'roleplay', 'S');
    expect(setLiveDirectionMode(scene, 'editor')).toBe(true);
    expect(getScene(scene.id).liveDirection.mode).toBe('editor');
    expect(setLiveDirectionMode(scene, 'bogus')).toBe(false);
});
