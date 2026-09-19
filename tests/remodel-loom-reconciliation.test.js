import { __setExtensionSettings } from './util/st-context-stub.js';
import { usesLoomReconciliation, buildLoomPrompt, parseLoomReply, readLoomProse, applySwaps , describeLoomReply, LOOM_OUTPUT_CONTRACT_PATCH, LOOM_POLICY_PATCH } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/loom-reconciliation.js';
import { setLiveDirectionMode } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js';
import { createArc, createScene, createTimeline, getScene } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/timeline-state.js';

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

test('the built-in Loom fallback is the patch contract, never a rewrite', () => {
    const messages = buildLoomPrompt({
        playerAction: 'I lower my voice and ask Marisol, “What is your mantra?”',
        draft: 'Eli leans in and Marissa melts into him.',
        draftReasoning: 'He goes for the kiss.',
        livingLore: '## Selected Living Lore\n- Marissa: guarded',
    });
    const system = messages.find((m) => m.role === 'system').content;
    const user = messages.find((m) => m.role === 'user').content;
    // The retired contract asked for the whole turn to be re-emitted. The
    // fallback must never do that again.
    expect(system).not.toMatch(/complete final scene prose/i);
    expect(system).toMatch(/do NOT rewrite or reproduce it/);
    expect(system).toMatch(/Output NOTHING except one state fence/);
    expect(system).toContain('```state');
    expect(system).toContain('Marissa: guarded');                         // the injected living lore
    expect(user).toContain('Eli leans in and Marissa melts into him.');    // the draft
    expect(user).toContain('He goes for the kiss.');                       // draft reasoning
    expect(user).toContain('CURRENT PLAYER ACTION — AUTHORITATIVE TURN INPUT');
    expect(user).toContain('What is your mantra?');
    expect(user).toMatch(/outranks conflicting inference/i);
});

test('parseLoomReply reads swaps and lore ops from the state fence', () => {
    const raw = [
        'The Loom need not write any prose here — it is ignored.',
        '```state',
        '{"swaps":[{"find":"Marissa melts into him","replace":"Marissa turns her cheek"}],'
        + '"loreKeywords":[],"loreOps":[{"id":"o1","op":"lore.edit","arguments":{"book":"TL","uid":"3","content":"Marissa pulled back from Eli."},"reason":"the accepted prose changed this"}],"flow":{"continue":false}}',
        '```',
    ].join('\n');
    const { swaps, loreOps } = parseLoomReply(raw);
    expect(swaps).toEqual([{ find: 'Marissa melts into him', replace: 'Marissa turns her cheek' }]);
    expect(loreOps).toHaveLength(1);
    expect(loreOps[0]).toMatchObject({ op: 'lore.edit', book: 'TL', uid: '3' });
});

test('parseLoomReply drops malformed swaps and defaults to none', () => {
    const raw = ['```state', '{"swaps":[{"find":"","replace":"x"},{"replace":"no find"},{"find":"ok","replace":"y"}],"loreOps":[]}', '```'].join('\n');
    const { swaps, loreOps } = parseLoomReply(raw);
    expect(swaps).toEqual([{ find: 'ok', replace: 'y' }]);  // empty find and missing find dropped
    expect(loreOps).toEqual([]);
    expect(parseLoomReply('No fence at all.')).toEqual({ prose: 'No fence at all.', swaps: [], flow: null, loreKeywords: [], loreOps: [] });
});

test('readLoomProse exposes prose while withholding partial and complete state fences', () => {
    expect(readLoomProse('The guard reaches for the alarm—')).toBe('The guard reaches for the alarm—');
    expect(readLoomProse('The guard reaches.\n``')).toBe('The guard reaches.');
    expect(readLoomProse('The guard reaches.\n```sta')).toBe('The guard reaches.');
    expect(readLoomProse('The guard reaches.\n```state\n{"loreOps":[]')).toBe('The guard reaches.');
});

test('a whole json-fenced Loom envelope is recovered without becoming visible prose', () => {
    const raw = '```json\n{"swaps":[],"loreKeywords":[],"loreOps":[{"id":"o1","op":"lore.create","arguments":{"name":"Marissa dossier","keys":["dossier"],"content":"Notes on Marissa."},"reason":"a new durable subject"}],"flow":{"continue":false}}\n```';
    const parsed = parseLoomReply(raw);
    expect(readLoomProse(raw)).toBe('');
    expect(parsed.prose).toBe('');
    expect(parsed.loreOps).toHaveLength(1);
    expect(parsed.loreOps[0]).toMatchObject({ op: 'lore.create', name: 'Marissa dossier' });
    expect(describeLoomReply(raw).fenceFormat).toBe('json-fence-recovered');
});

test('a bare whole-reply Loom envelope is recovered but incidental prose JSON is not', () => {
    const raw = '{"swaps":[],"loreKeywords":[],"loreOps":[{"id":"o1","op":"lore.edit","arguments":{"book":"TL","uid":"1","content":"The pendant warmed."},"reason":"stated in the prose"}]}';
    expect(readLoomProse(raw)).toBe('');
    expect(parseLoomReply(raw).loreOps[0]).toMatchObject({ op: 'lore.edit', uid: '1' });
    expect(describeLoomReply(raw).fenceFormat).toBe('bare-json-recovered');

    const prose = 'The terminal displayed {"loreOps":[]} and went dark.';
    expect(parseLoomReply(prose)).toEqual({ prose, swaps: [], flow: null, loreKeywords: [], loreOps: [] });
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
    expect(reply.loreOpCount).toBe(0);
    expect(reply.tail).toContain('no fence at all');
});

test('a malformed fence is distinguished from a missing one', () => {
    const reply = describeLoomReply('Prose.\n\n```state\n{"loreOps":[{,,,}]}\n```');
    expect(reply.hasFence).toBe(true);
    expect(reply.fenceParsed).toBe(false);
    expect(reply.loreOpCount).toBe(0);
});

test('repairs quoted lore-op objects at array boundaries without general JSON guessing', () => {
    const malformed = '```state\n{"loreOps":[{"id":"o1","op":"lore.edit","arguments":{"book":"TL","uid":"1","content":"one"},"reason":"a"},"{"id":"o2","op":"lore.edit","arguments":{"book":"TL","uid":"2","content":"two"},"reason":"b"}],"flow":{"continue":false}}\n```';
    const described = describeLoomReply(malformed);
    expect(described).toMatchObject({ hasFence: true, fenceParsed: true, fenceFormat: 'state-quoted-object-repaired', loreOpCount: 2 });
    expect(parseLoomReply(malformed).loreOps.map((op) => op.uid)).toEqual(['1', '2']);

    const unrelatedDamage = '```state\n{"loreOps":[{"id":"o1"} BROKEN]}\n```';
    expect(describeLoomReply(unrelatedDamage)).toMatchObject({ hasFence: true, fenceParsed: false });
});

test('repairs one structurally impossible extra lore-op closer without guessing missing JSON', () => {
    const malformed = '```state\n{"loreOps":[{"id":"o1","op":"lore.edit","arguments":{"book":"TL","uid":"1","content":"one"},"reason":"a"}},{"id":"o2","op":"lore.edit","arguments":{"book":"TL","uid":"2","content":"two"},"reason":"b"}}],"flow":{"continue":false}}\n```';
    const described = describeLoomReply(malformed);
    expect(described).toMatchObject({ hasFence: true, fenceParsed: true, fenceFormat: 'state-extra-closer-repaired', loreOpCount: 2 });
    expect(parseLoomReply(malformed).loreOps.map((op) => op.uid)).toEqual(['1', '2']);

    const missingCloser = '```state\n{"loreOps":[{"id":"o1","arguments":{"summary":"one"}],"flow":{"continue":false}}\n```';
    expect(describeLoomReply(missingCloser)).toMatchObject({ hasFence: true, fenceParsed: false });
});

test('a valid fence reports the counts it carried', () => {
    const fence = JSON.stringify({
        swaps: [{ find: 'a', replace: 'b' }],
        loreKeywords: [['Marissa'], ['event', 'dock']],
        loreOps: [
            { id: 'o1', op: 'lore.edit', arguments: { book: 'TL', uid: '1', content: 'x' }, reason: 'r' },
            { id: 'o2', op: 'lore.create', arguments: { name: 'Dock', keys: ['dock'], content: 'y' }, reason: 'r' },
        ],
        flow: { continue: false },
    });
    const reply = describeLoomReply(`Prose.\n\n\`\`\`state\n${fence}\n\`\`\``);
    expect(reply.hasFence).toBe(true);
    expect(reply.fenceParsed).toBe(true);
    expect(reply.swapCount).toBe(1);
    expect(reply.loreKeywordCount).toBe(2);
    expect(reply.loreOpCount).toBe(2);
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
        loreOps: [],
    });
    const parsed = parseLoomReply(raw);
    expect(parsed.prose).toBe('');
    expect(parsed.swaps).toHaveLength(1);
    const committed = parsed.prose || applySwaps(draft, parsed.swaps).prose;
    expect(committed).toBe('She crossed the room and failed to open the window.');
});

test('a fence-only reply with no swaps leaves the draft exactly as written', () => {
    const draft = 'Nothing in the fiction needed correcting.';
    const raw = fenceOnly({ swaps: [], loreOps: [{ id: 'o1', op: 'lore.edit', arguments: { book: 'TL', uid: '1', content: 'noted' }, reason: 'r' }] });
    const parsed = parseLoomReply(raw);
    expect(parsed.prose).toBe('');
    expect(parsed.loreOps).toHaveLength(1);
    expect(parsed.prose || applySwaps(draft, parsed.swaps).prose).toBe(draft);
});

// A swap whose anchor the model paraphrased must never corrupt the prose.
test('a patch whose find is not in the draft is skipped, leaving the draft intact', () => {
    const draft = 'She crossed the room.';
    const raw = fenceOnly({ swaps: [{ find: 'walked across the room', replace: 'stumbled' }], loreOps: [] });
    const parsed = parseLoomReply(raw);
    const result = applySwaps(draft, parsed.swaps);
    expect(result.applied).toBe(0);
    expect(result.prose).toBe(draft);
});

test('the Loom can ask for a retrieval by naming keyword groups', () => {
    const raw = ['```state', '{"loreKeywords":[["Queens Lake University"],["event","Marissa"]]}', '```'].join('\n');
    expect(parseLoomReply(raw).loreKeywords).toEqual([['Queens Lake University'], ['event', 'Marissa']]);
});

test('an empty fence leaves the working set standing', () => {
    const raw = ['```state', '{"loreOps":[]}', '```'].join('\n');
    expect(parseLoomReply(raw).loreKeywords).toEqual([]);
});

test('a keyword group is bounded, deduplicated and cleaned', () => {
    const many = Array.from({ length: 20 }, (_v, index) => `term-${index}`);
    const raw = ['```state', JSON.stringify({ loreKeywords: [['  Teo  ', 'Teo', '', null, ...many]] }), '```'].join('\n');
    const groups = parseLoomReply(raw).loreKeywords;
    // One group: trimmed, deduplicated, blanks dropped, and capped per group —
    // a group naming half the book is not a request.
    expect(groups).toHaveLength(1);
    const keywords = groups[0];
    expect(keywords[0]).toBe('Teo');
    expect(keywords).toHaveLength(8);
    expect(new Set(keywords).size).toBe(8);
});

test('a malformed keyword request is ignored rather than throwing', () => {
    for (const bad of ['not-an-array', 42, {}, null]) {
        const raw = ['```state', JSON.stringify({ loreKeywords: bad }), '```'].join('\n');
        expect(parseLoomReply(raw).loreKeywords).toEqual([]);
    }
});
