import { parseDirectorReply, ENTRY_TYPES } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/director-reply.js';

test('splits line-leading tags into typed entries', () => {
    const { entries } = parseDirectorReply('[note] Teo is stalling.\n[secret] He saw the janitor.\n[ruling] If Eli sits, Teo talks.');
    expect(entries).toEqual([
        { type: 'note', text: 'Teo is stalling.' },
        { type: 'secret', text: 'He saw the janitor.' },
        { type: 'ruling', text: 'If Eli sits, Teo talks.' },
    ]);
});

test('untagged leading prose becomes a note rather than being dropped', () => {
    const { entries } = parseDirectorReply('Teo stalls, and the rain starts.\n[result] Eli sat down.');
    expect(entries[0]).toEqual({ type: 'note', text: 'Teo stalls, and the rain starts.' });
    expect(entries[1].type).toBe('result');
});

test('an unknown tag stays literal text inside the current entry', () => {
    const { entries } = parseDirectorReply('[note] Teo stalls.\n[foreshadow] the closet\n[result] Eli sat.');
    expect(entries).toHaveLength(2);
    expect(entries[0].text).toBe('Teo stalls.\n[foreshadow] the closet');
});

test('reads the LAST state fence, so mid-reply talk about state cannot confuse it', () => {
    const reply = [
        '[note] Earlier I almost sent this, but changed my mind:',
        '```state',
        '{"requests":[],"flow":{"continue":false}}',
        '```',
        '[note] On reflection, here is what actually happens.',
        '```state',
        '{"requests":[{"capability":"variable.adjust","name":"Morale","amount":-1}],"flow":{"continue":true}}',
        '```',
    ].join('\n');
    const { state, tailFound } = parseDirectorReply(reply);
    expect(tailFound).toBe(true);
    expect(state.requests).toEqual([{ capability: 'variable.adjust', name: 'Morale', amount: -1 }]);
    expect(state.flow.continue).toBe(true);
});

test('the tail is stripped from the stored entry text', () => {
    const { entries } = parseDirectorReply('[note] Teo stalls.\n```state\n{"requests":[]}\n```');
    expect(entries[0].text).toBe('Teo stalls.');
    expect(JSON.stringify(entries)).not.toContain('state');
});

test('a missing tail is not an error and stops the scene', () => {
    const { state, tailFound, tailError } = parseDirectorReply('[note] Nothing mechanical happened.');
    expect(tailFound).toBe(false);
    expect(tailError).toBe('');
    expect(state.requests).toEqual([]);
    expect(state.flow.continue).toBe(false);
});

test('a malformed tail reports the error, yields no requests, and stops', () => {
    const { state, tailFound, tailError } = parseDirectorReply('[note] Hm.\n```state\n{"requests": [oh no\n```');
    expect(tailFound).toBe(true);
    expect(tailError).not.toBe('');
    expect(state.requests).toEqual([]);
    expect(state.flow.continue).toBe(false);
});

test('exports the four types and only those', () => {
    expect(ENTRY_TYPES).toEqual(['note', 'ruling', 'result', 'secret']);
});
