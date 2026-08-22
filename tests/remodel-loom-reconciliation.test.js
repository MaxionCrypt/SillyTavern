import { __setExtensionSettings } from './util/st-context-stub.js';
import { usesLoomReconciliation, buildLoomPrompt, parseLoomReply, readLoomProse, applySwaps } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/loom-reconciliation.js';
import { setLiveDirectionMode } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js';
import { createArc, createScene, createTimeline, getScene } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/timeline-state.js';
import { buildGoalObjectives } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/narrator-prompt.js';
import { createTimelineGoal } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/story-goals-store.js';

beforeEach(() => __setExtensionSettings({ remodel: {} }));

test('usesLoomReconciliation is true only for Loom mode', () => {
    expect(usesLoomReconciliation({ liveDirection: { mode: 'loom' } })).toBe(true);
    expect(usesLoomReconciliation({ liveDirection: { mode: 'solo' } })).toBe(false);
    expect(usesLoomReconciliation({ liveDirection: {} })).toBe(false);
    expect(usesLoomReconciliation(null)).toBe(false);
});

test('setLiveDirectionMode accepts only Loom', () => {
    const scene = createScene(createArc(createTimeline('T').id, 'A').id, 'roleplay', 'S');
    expect(setLiveDirectionMode(scene, 'loom')).toBe(true);
    expect(getScene(scene.id).liveDirection.mode).toBe('loom');
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

test('the Loom prompt asks for complete final prose followed by the state fence', () => {
    const messages = buildLoomPrompt({
        draft: 'Eli leans in and Marissa melts into him.',
        draftReasoning: 'He goes for the kiss.',
        narrativeState: '## Scene\n- location: cafe',
        mechanicsSkill: '- Goal "Win Marissa over" (30%)',
    });
    const system = messages.find((m) => m.role === 'system').content;
    const user = messages.find((m) => m.role === 'user').content;
    expect(system).toMatch(/complete final prose/i);
    expect(system).toMatch(/state fence/i);
    expect(system).toMatch(/goal\.reach/i);                                // rolls via goal.reach
    expect(system).toMatch(/even the characters|genuinely.*doubt|routine/i); // rare uncertainty
    expect(system).toContain('```state');
    expect(system).toContain('Win Marissa over');                          // mechanical state (with numbers)
    expect(user).toContain('Eli leans in and Marissa melts into him.');    // the draft
    expect(user).toContain('He goes for the kiss.');                       // draft reasoning
});

test('parseLoomReply reads swaps and requests from the state fence', () => {
    const raw = [
        'The Loom need not write any prose here — it is ignored.',
        '```state',
        '{"swaps":[{"find":"Marissa melts into him","replace":"Marissa turns her cheek"}],'
        + '"requests":[{"id":"r1","capability":"event.record","arguments":{"summary":"Eli tried to kiss Marissa; she pulled back"},"reason":"seduction roll failed"}],"flow":{"continue":false}}',
        '```',
    ].join('\n');
    const { swaps, requests } = parseLoomReply(raw);
    expect(swaps).toEqual([{ find: 'Marissa melts into him', replace: 'Marissa turns her cheek' }]);
    expect(requests).toHaveLength(1);
    expect(requests[0].capability).toBe('event.record');
});

test('parseLoomReply drops malformed swaps and defaults to none', () => {
    const raw = ['```state', '{"swaps":[{"find":"","replace":"x"},{"replace":"no find"},{"find":"ok","replace":"y"}],"requests":[]}', '```'].join('\n');
    const { swaps, requests } = parseLoomReply(raw);
    expect(swaps).toEqual([{ find: 'ok', replace: 'y' }]);  // empty find and missing find dropped
    expect(requests).toEqual([]);
    expect(parseLoomReply('No fence at all.')).toEqual({ prose: 'No fence at all.', swaps: [], requests: [], flow: null });
});

test('readLoomProse exposes prose while withholding partial and complete state fences', () => {
    expect(readLoomProse('The guard reaches for the alarm—')).toBe('The guard reaches for the alarm—');
    expect(readLoomProse('The guard reaches.\n``')).toBe('The guard reaches.');
    expect(readLoomProse('The guard reaches.\n```sta')).toBe('The guard reaches.');
    expect(readLoomProse('The guard reaches.\n```state\n{"requests":[]')).toBe('The guard reaches.');
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
