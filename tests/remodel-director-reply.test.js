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

// Review I4: the PROTOCOL used to promise "A line with no tag is read as a
// note", which is not what this parser does and not what design §3 specifies.
// The contract was corrected rather than the parser, because continuation IS
// the feature — without it a Director cannot write a ruling longer than one
// line — and because a `[secret]` followed by untagged prose was silently
// withholding colour the model had been told would reach the performer.
//
// These two tests are the parser half of that agreement. The contract half
// lives in remodel-direction-sources.test.js.
test('an untagged line continues the entry above it rather than starting a note', () => {
    const { entries } = parseDirectorReply('[ruling] Teo talks once Eli sits.\nHe does not look up while he says it.');
    expect(entries).toEqual([
        { type: 'ruling', text: 'Teo talks once Eli sits.\nHe does not look up while he says it.' },
    ]);
});

test('untagged prose after a [secret] stays inside the secret, which is why the contract had to say so', () => {
    // The concrete loss the wrong sentence caused: under "a line with no tag
    // is read as a note", a Director writing this expects the second line to
    // reach the performer. It does not — it is part of the secret, and
    // readNarratorEntries withholds the whole entry. Safe (nothing is promoted
    // OUT of secret) but silent, on a branch whose stated risk is that
    // anything the Director fails to record is invisible to the performer.
    const { entries } = parseDirectorReply('[secret] The boy already knows.\nThe rain gets heavier, and Teo notices.');
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('secret');
    expect(entries[0].text).toBe('The boy already knows.\nThe rain gets heavier, and Teo notices.');
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

test('hostile non-string input degrades to the empty shape instead of throwing', () => {
    const throwsOnCoercion = {
        toString() { throw new Error('toString exploded'); },
        valueOf() { throw new Error('valueOf exploded'); },
    };
    const nullProto = Object.create(null);

    expect(() => parseDirectorReply(throwsOnCoercion)).not.toThrow();
    expect(() => parseDirectorReply(nullProto)).not.toThrow();

    const empty = { entries: [], state: { requests: [], flow: { continue: false } }, tailFound: false, tailError: '' };
    expect(parseDirectorReply(throwsOnCoercion)).toEqual(empty);
    expect(parseDirectorReply(nullProto)).toEqual(empty);
});
