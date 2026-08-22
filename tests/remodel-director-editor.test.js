import { __setExtensionSettings } from './util/st-context-stub.js';
import { isEditorMode, buildDirectorEditorPrompt, parseEditorReply, applySwaps } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/director-editor.js';
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

test('the editor prompt: keep the draft verbatim, patch only via swaps, output only a fence', () => {
    const messages = buildDirectorEditorPrompt({
        draft: 'Eli leans in and Marissa melts into him.',
        draftReasoning: 'He goes for the kiss.',
        narrativeState: '## Scene\n- location: cafe',
        mechanicsSkill: '- Goal "Win Marissa over" (30%)',
    });
    const system = messages.find((m) => m.role === 'system').content;
    const user = messages.find((m) => m.role === 'user').content;
    expect(system).toMatch(/kept as written|verbatim|do not rewrite/i);   // draft preserved in code
    expect(system).toMatch(/swap/i);                                       // patch via swaps
    expect(system).toMatch(/"find"|"replace"/);                           // find/replace shape
    expect(system).toMatch(/no narration|only the state fence/i);         // model writes no prose
    expect(system).toMatch(/goal\.reach/i);                                // rolls via goal.reach
    expect(system).toMatch(/even the characters|genuinely.*doubt|routine/i); // rare uncertainty
    expect(system).toContain('```state');
    expect(system).toContain('Win Marissa over');                          // mechanical state (with numbers)
    expect(user).toContain('Eli leans in and Marissa melts into him.');    // the draft
    expect(user).toContain('He goes for the kiss.');                       // draft reasoning
});

test('parseEditorReply reads swaps and requests from the state fence', () => {
    const raw = [
        'The Director need not write any prose here — it is ignored.',
        '```state',
        '{"swaps":[{"find":"Marissa melts into him","replace":"Marissa turns her cheek"}],'
        + '"requests":[{"id":"r1","capability":"event.record","arguments":{"summary":"Eli tried to kiss Marissa; she pulled back"},"reason":"seduction roll failed"}],"flow":{"continue":false}}',
        '```',
    ].join('\n');
    const { swaps, requests } = parseEditorReply(raw);
    expect(swaps).toEqual([{ find: 'Marissa melts into him', replace: 'Marissa turns her cheek' }]);
    expect(requests).toHaveLength(1);
    expect(requests[0].capability).toBe('event.record');
});

test('parseEditorReply drops malformed swaps and defaults to none', () => {
    const raw = ['```state', '{"swaps":[{"find":"","replace":"x"},{"replace":"no find"},{"find":"ok","replace":"y"}],"requests":[]}', '```'].join('\n');
    const { swaps, requests } = parseEditorReply(raw);
    expect(swaps).toEqual([{ find: 'ok', replace: 'y' }]);  // empty find and missing find dropped
    expect(requests).toEqual([]);
    expect(parseEditorReply('No fence at all.')).toEqual({ swaps: [], requests: [] });
});

test('applySwaps patches only the named span and keeps the rest of the draft verbatim', () => {
    const draft = 'Eli leans in and Marissa melts into him. The room holds its breath.';
    const { prose, applied } = applySwaps(draft, [{ find: 'Marissa melts into him', replace: 'Marissa turns her cheek' }]);
    expect(prose).toBe('Eli leans in and Marissa turns her cheek. The room holds its breath.');
    expect(applied).toBe(1);
});

test('applySwaps skips a swap whose find is not in the draft — never corrupts the prose', () => {
    const draft = 'Eli leans in and Marissa melts into him.';
    const { prose, applied } = applySwaps(draft, [{ find: 'she slaps him', replace: 'she laughs' }]);
    expect(prose).toBe(draft);   // unchanged
    expect(applied).toBe(0);
});

test('applySwaps with no swaps returns the draft untouched', () => {
    const draft = 'Nothing was rolled, so nothing changes.';
    expect(applySwaps(draft, [])).toEqual({ prose: draft, applied: 0 });
});
