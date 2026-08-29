import { __setExtensionSettings } from './util/st-context-stub.js';
import { usesLoomReconciliation, buildLoomPrompt, parseLoomReply, readLoomProse, applySwaps , describeLoomReply, LOOM_OUTPUT_CONTRACT_PATCH, LOOM_POLICY_PATCH } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/loom-reconciliation.js';
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
        playerAction: 'I lower my voice and ask Marisol, “What is your mantra?”',
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
    expect(system).toMatch(/genuinely uncertain|routine/i); // rare uncertainty
    expect(system).toMatch(/not an exhaustive whitelist/i);
    expect(system).toContain('```state');
    expect(system).toContain('Win Marissa over');                          // mechanical state (with numbers)
    expect(user).toContain('Eli leans in and Marissa melts into him.');    // the draft
    expect(user).toContain('He goes for the kiss.');                       // draft reasoning
    expect(user).toContain('CURRENT PLAYER ACTION — AUTHORITATIVE TURN INPUT');
    expect(user).toContain('What is your mantra?');
    expect(user).toMatch(/outranks conflicting inference/i);
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
    expect(parseLoomReply('No fence at all.')).toEqual({ prose: 'No fence at all.', swaps: [], requests: [], flow: null, loreProposals: [], loreProposalRejections: [] });
});

test('readLoomProse exposes prose while withholding partial and complete state fences', () => {
    expect(readLoomProse('The guard reaches for the alarm—')).toBe('The guard reaches for the alarm—');
    expect(readLoomProse('The guard reaches.\n``')).toBe('The guard reaches.');
    expect(readLoomProse('The guard reaches.\n```sta')).toBe('The guard reaches.');
    expect(readLoomProse('The guard reaches.\n```state\n{"requests":[]')).toBe('The guard reaches.');
});

test('a whole json-fenced Loom envelope is recovered without becoming visible prose', () => {
    const raw = '```json\n{"swaps":[],"requests":[{"id":"r1","capability":"goal.create","arguments":{"title":"Marissa investigates"}}],"flow":{"continue":false}}\n```';
    const parsed = parseLoomReply(raw);
    expect(readLoomProse(raw)).toBe('');
    expect(parsed.prose).toBe('');
    expect(parsed.requests).toHaveLength(1);
    expect(parsed.requests[0].capability).toBe('goal.create');
    expect(describeLoomReply(raw).fenceFormat).toBe('json-fence-recovered');
});

test('a bare whole-reply Loom envelope is recovered but incidental prose JSON is not', () => {
    const raw = '{"swaps":[],"requests":[{"id":"r1","capability":"event.record","arguments":{"summary":"The pendant warmed."}}]}';
    expect(readLoomProse(raw)).toBe('');
    expect(parseLoomReply(raw).requests[0].capability).toBe('event.record');
    expect(describeLoomReply(raw).fenceFormat).toBe('bare-json-recovered');

    const prose = 'The terminal displayed {"requests":[]} and went dark.';
    expect(parseLoomReply(prose)).toEqual({ prose, swaps: [], requests: [], flow: null, loreProposals: [], loreProposalRejections: [] });
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

// describeLoomReply exists to tell apart three failures that all surface as the
// same symptom — an Archive that quietly did not advance.
test('a reply with no state fence is reported as having none', () => {
    const reply = describeLoomReply('Just the prose, no fence at all.');
    expect(reply.hasFence).toBe(false);
    expect(reply.fenceParsed).toBe(false);
    expect(reply.capabilities).toEqual([]);
    expect(reply.tail).toContain('no fence at all');
});

test('a malformed fence is distinguished from a missing one', () => {
    const reply = describeLoomReply('Prose.\n\n```state\n{"requests":[{,,,}]}\n```');
    expect(reply.hasFence).toBe(true);
    expect(reply.fenceParsed).toBe(false);
    expect(reply.capabilities).toEqual([]);
});

test('repairs quoted request objects at array boundaries without general JSON guessing', () => {
    const malformed = '```state\n{"requests":[{"id":"r1","capability":"event.record","arguments":{"summary":"one"}},"{"id":"r2","capability":"beat.set","arguments":{"directive":"next"}}],"flow":{"continue":false}}\n```';
    const described = describeLoomReply(malformed);
    expect(described).toMatchObject({ hasFence: true, fenceParsed: true, fenceFormat: 'state-quoted-object-repaired', requestCount: 2 });
    expect(parseLoomReply(malformed).requests.map((request) => request.id)).toEqual(['r1', 'r2']);

    const unrelatedDamage = '```state\n{"requests":[{"id":"r1"} BROKEN]}\n```';
    expect(describeLoomReply(unrelatedDamage)).toMatchObject({ hasFence: true, fenceParsed: false });
});

test('repairs one structurally impossible extra request closer without guessing missing JSON', () => {
    const malformed = '```state\n{"requests":[{"id":"r1","capability":"event.record","arguments":{"summary":"one"},"reason":"accepted"}},{"id":"r2","capability":"beat.set","arguments":{"directive":"next"},"reason":"open"}}],"flow":{"continue":false}}\n```';
    const described = describeLoomReply(malformed);
    expect(described).toMatchObject({ hasFence: true, fenceParsed: true, fenceFormat: 'state-extra-closer-repaired', requestCount: 2 });
    expect(parseLoomReply(malformed).requests.map((request) => request.id)).toEqual(['r1', 'r2']);

    const missingCloser = '```state\n{"requests":[{"id":"r1","arguments":{"summary":"one"}],"flow":{"continue":false}}\n```';
    expect(describeLoomReply(missingCloser)).toMatchObject({ hasFence: true, fenceParsed: false });
});

test('a valid fence reports the capabilities it named', () => {
    const fence = JSON.stringify({ requests: [
        { id: 'r1', capability: 'event.record', arguments: { summary: 'x' } },
        { id: 'r2', capability: 'goal.reach', arguments: {} },
    ], flow: { continue: false } });
    const reply = describeLoomReply(`Prose.\n\n\`\`\`state\n${fence}\n\`\`\``);
    expect(reply.hasFence).toBe(true);
    expect(reply.fenceParsed).toBe(true);
    expect(reply.capabilities).toEqual(['event.record', 'goal.reach']);
    expect(reply.requestCount).toBe(2);
});

test('a request with no capability name is still counted, not silently dropped', () => {
    const fence = JSON.stringify({ requests: [{ id: 'r1', arguments: {} }] });
    const reply = describeLoomReply(`Prose.\n\n\`\`\`state\n${fence}\n\`\`\``);
    expect(reply.capabilities).toEqual(['(missing)']);
});

test('the summary is bounded so a long turn cannot bury the journal', () => {
    const long = 'x'.repeat(50000);
    const reply = describeLoomReply(long, { tailChars: 100 });
    expect(reply.length).toBe(50000);
    expect(reply.tail.length).toBe(100);
});

// THE PATCH CONTRACT. Under the default contract the Loom had to re-emit the
// whole turn before it could write its state fence — 17 to 94 seconds per turn
// on the live session, re-typing prose that already existed. Here it names only
// the spans a ruling changes and applySwaps() patches the draft in code.
const FENCE = `${String.fromCharCode(96, 96, 96)}state`;
const FENCE_END = String.fromCharCode(96, 96, 96);
const fenceOnly = (payload) => `${FENCE}\n${JSON.stringify(payload)}\n${FENCE_END}`;

test('the patch contract forbids restating the prose', () => {
    expect(LOOM_OUTPUT_CONTRACT_PATCH).toMatch(/Output NOTHING except one state fence/);
    expect(LOOM_OUTPUT_CONTRACT_PATCH).toMatch(/swaps/);
    expect(LOOM_OUTPUT_CONTRACT_PATCH).not.toMatch(/complete final scene prose/);
    expect(LOOM_POLICY_PATCH).toMatch(/do NOT rewrite or reproduce it/);
});

// The whole saving depends on this: a reply that is ONLY a fence must leave
// prose empty, so the caller falls through to applySwaps against the draft.
test('a fence-only reply yields no prose, so the draft is what gets patched', () => {
    const draft = 'She crossed the room and opened the window.';
    const raw = fenceOnly({
        swaps: [{ find: 'opened the window', replace: 'failed to open the window' }],
        requests: [],
    });
    const parsed = parseLoomReply(raw);
    expect(parsed.prose).toBe('');
    expect(parsed.swaps).toHaveLength(1);
    const committed = parsed.prose || applySwaps(draft, parsed.swaps).prose;
    expect(committed).toBe('She crossed the room and failed to open the window.');
});

test('a fence-only reply with no swaps leaves the draft exactly as written', () => {
    const draft = 'Nothing in the fiction needed correcting.';
    const raw = fenceOnly({ swaps: [], requests: [{ id: 'r1', capability: 'event.record', arguments: {} }] });
    const parsed = parseLoomReply(raw);
    expect(parsed.prose).toBe('');
    expect(parsed.requests).toHaveLength(1);
    expect(parsed.prose || applySwaps(draft, parsed.swaps).prose).toBe(draft);
});

// A swap whose anchor the model paraphrased must never corrupt the prose.
test('a patch whose find is not in the draft is skipped, leaving the draft intact', () => {
    const draft = 'She crossed the room.';
    const raw = fenceOnly({ swaps: [{ find: 'walked across the room', replace: 'stumbled' }], requests: [] });
    const parsed = parseLoomReply(raw);
    const result = applySwaps(draft, parsed.swaps);
    expect(result.applied).toBe(0);
    expect(result.prose).toBe(draft);
});
