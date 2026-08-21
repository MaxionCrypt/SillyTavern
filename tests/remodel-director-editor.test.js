import { __setExtensionSettings } from './util/st-context-stub.js';
import { isEditorMode, buildDirectorEditorPrompt, parseEditorReply } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/director-editor.js';
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

test('the editor prompt: preserve-and-patch, roll only genuine uncertainty, output prose then a fence', () => {
    const messages = buildDirectorEditorPrompt({
        draft: 'Eli leans in and Marissa melts into him.',
        draftReasoning: 'He goes for the kiss.',
        narrativeState: '## Scene\n- location: cafe',
        mechanicsSkill: '- Goal "Win Marissa over" (30%)',
    });
    const system = messages.find((m) => m.role === 'system').content;
    const user = messages.find((m) => m.role === 'user').content;
    expect(system).toMatch(/verbatim|word.for.word|only the .*(beat|sentence)/i); // preserve-and-patch
    expect(system).toMatch(/goal\.reach/i);                                       // rolls via goal.reach
    expect(system).toMatch(/even the characters|genuinely.*doubt|routine/i);      // rare uncertainty
    expect(system).toContain('```state');                                         // fence after prose
    expect(system).toContain('Win Marissa over');                                 // mechanical state (with numbers)
    expect(user).toContain('Eli leans in and Marissa melts into him.');           // the draft
    expect(user).toContain('He goes for the kiss.');                              // draft reasoning
});

test('parseEditorReply splits committed prose from the state fence', () => {
    const raw = [
        'Eli leans in, but Marissa turns her cheek at the last second.',
        '',
        '```state',
        '{"requests":[{"id":"r1","capability":"event.record","arguments":{"summary":"Eli tried to kiss Marissa; she pulled back"},"reason":"seduction roll failed"}],"flow":{"continue":false}}',
        '```',
    ].join('\n');
    const { prose, requests } = parseEditorReply(raw);
    expect(prose).toBe('Eli leans in, but Marissa turns her cheek at the last second.');
    expect(requests).toHaveLength(1);
    expect(requests[0].capability).toBe('event.record');
});

test('parseEditorReply with no fence returns all prose and no requests', () => {
    const { prose, requests } = parseEditorReply('Just prose, nothing rolled.');
    expect(prose).toBe('Just prose, nothing rolled.');
    expect(requests).toEqual([]);
});
