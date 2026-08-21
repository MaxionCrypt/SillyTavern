import { __setExtensionSettings } from './util/st-context-stub.js';
import { isEditorMode } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/director-editor.js';
import { setLiveDirectionMode } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js';
import { createArc, createScene, createTimeline, getScene } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/timeline-state.js';
import { buildGoalObjectives } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/narrator-prompt.js';
import { createTimelineGoal } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/story-goals-store.js';

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

test('goal objectives render title + description, never the odds or status number', () => {
    createTimelineGoal('tl-obj', {
        title: 'Win Marissa over', description: 'Eli wants her trust', successRate: 30,
        visibility: 'public', holderRefs: [{ kind: 'character', id: 'eli', label: 'Eli' }],
    }, { sceneId: 'sc-obj' });
    const text = buildGoalObjectives('sc-obj');
    expect(text).toContain('Win Marissa over');
    expect(text).toContain('Eli wants her trust');
    expect(text).not.toContain('30');       // no odds
    expect(text).not.toMatch(/%/);          // no percentage
    expect(buildGoalObjectives('sc-empty')).toBe('');
});
