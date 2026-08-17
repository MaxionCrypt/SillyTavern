import { stripEchoedScaffolding } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction-markers.js';

// Models trained on roleplay transcripts echo the furniture around a reply as
// if it were part of one. Core strips the `{{char}}:` half in cleanUpMessage,
// but Live Direction owns its own buffer and writes the accepted text itself,
// so it never passes through that.
//
// These tests are mostly about what must SURVIVE. This function edits the
// user's fiction, and a false positive silently deletes prose they wrote a
// scene around.

const NARRATOR = 'The Narrator II';

test('the case from the owner\'s log', () => {
    // Verbatim, including the model's own typo in the name it invented.
    const raw = "[IMPORTANT: This reply must constitute the entirety of The Narrato II's response to the user.]The Narrator II: The page flipped.";

    expect(stripEchoedScaffolding(raw, NARRATOR)).toBe('The page flipped.');
});

test('a bare speaker prefix goes', () => {
    expect(stripEchoedScaffolding('The Narrator II: The page flipped.', NARRATOR)).toBe('The page flipped.');
    expect(stripEchoedScaffolding('  the narrator ii :  The page flipped.', NARRATOR)).toBe('The page flipped.');
});

test('a bracketed opening that is NOT followed by scaffolding is left alone', () => {
    // This is prose. A reply may legitimately open on a bracketed aside, and
    // nothing here says otherwise — so it stays.
    const prose = '[The clock reads 2:17.] The radiator thumped.';

    expect(stripEchoedScaffolding(prose, NARRATOR)).toBe(prose);
});

test('another character\'s name is never treated as a prefix', () => {
    // The single most damaging false positive available: a generic `Word:`
    // rule would eat the opening line of dialogue in half the scenes there are.
    const line = 'Teo: Don\'t "Really Teo" me, I know what I\'m doing.';

    expect(stripEchoedScaffolding(line, NARRATOR)).toBe(line);
});

test('a mid-prose bracket is prose', () => {
    const line = 'The page flipped. [IMPORTANT: this is a line of the story.] He read on.';

    expect(stripEchoedScaffolding(line, NARRATOR)).toBe(line);
});

test('stacked scaffolding is removed, and stops at the prose', () => {
    const raw = '[System note: stay in character.][IMPORTANT: reply as the narrator.]The Narrator II: The page flipped.';

    expect(stripEchoedScaffolding(raw, NARRATOR)).toBe('The page flipped.');
});

test('a later bracket in the prose does not extend the scaffolding match', () => {
    // A greedy `\[[\s\S]*\]` reaches the LAST bracket in the reply, so the
    // span stops looking like scaffolding and NOTHING is stripped — the
    // failure is silent and only shows on replies that happen to contain a
    // second bracket. The character class has to stop at the first `]`.
    const raw = '[System note: stay in character.]The Narrator II: The page [flipped] again.';

    expect(stripEchoedScaffolding(raw, NARRATOR)).toBe('The page [flipped] again.');
});

test('nothing is removed when no performer label is known', () => {
    // With no label there is no evidence a leading bracket was scaffolding, so
    // the conservative reading wins.
    const raw = "[IMPORTANT: reply as the narrator.]The Narrator II: The page flipped.";

    expect(stripEchoedScaffolding(raw, '')).toBe(raw);
});

test('a name with regex metacharacters is matched literally, not compiled', () => {
    expect(stripEchoedScaffolding('A.C. (Narrator): The page flipped.', 'A.C. (Narrator)')).toBe('The page flipped.');
    // And the metacharacters must not match a different name by accident.
    const other = 'AxCx xNarratorx: The page flipped.';
    expect(stripEchoedScaffolding(other, 'A.C. (Narrator)')).toBe(other);
});

test('an unterminated bracket is prose, not scaffolding', () => {
    const raw = '[IMPORTANT: the model never closed this bracket and kept writing';

    expect(stripEchoedScaffolding(raw, NARRATOR)).toBe(raw);
});

test('hostile input degrades instead of throwing', () => {
    expect(stripEchoedScaffolding(null, NARRATOR)).toBe('');
    expect(stripEchoedScaffolding(undefined)).toBe('');
    expect(() => stripEchoedScaffolding('[', NARRATOR)).not.toThrow();
    // A reply that is nothing but nested brackets must terminate.
    expect(() => stripEchoedScaffolding('[a][b][c][d][e][f]', NARRATOR)).not.toThrow();
});
