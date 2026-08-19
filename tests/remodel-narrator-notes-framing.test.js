import { buildDirectorNotesSource, frameDirectorReasoning } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js';
import { NARRATOR_VISIBLE_TYPES } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/director-reply.js';

// The Director's notes describe the STATE of the scene, and that state is the
// outcome of the response just written. So the block has to say what to DO
// with each line, or re-narrating it is a reasonable reading of the job — which
// is the Narrator-repeats-itself failure the owner reported.
//
// None of this was covered before, which is how "treat as settled fact"
// survived on a block containing rulings about a response not yet written.

const entry = (type, text, turn = 1) => ({ type, text, turn });

test('the header does not call everything settled fact', () => {
    // It was right for a `result` and wrong for a `ruling`, which is an
    // instruction about the response that has not been written yet.
    const source = buildDirectorNotesSource([entry('ruling', 'She answers before he finishes.')]);

    expect(source).not.toMatch(/settled fact/i);
});

test('the header says the notes are not prose to reproduce', () => {
    const source = buildDirectorNotesSource([entry('note', 'The radiator thumped.')]);

    expect(source).toMatch(/not prose to reproduce/i);
    expect(source).toMatch(/what happens NEXT/i);
});

test('a result is marked as something not to narrate again', () => {
    const source = buildDirectorNotesSource([entry('result', 'Teo dropped the key.')]);

    expect(source).toMatch(/do NOT narrate this again/i);
    expect(source).toContain('Teo dropped the key.');
});

test('a ruling is marked as binding on the next response, not as history', () => {
    const source = buildDirectorNotesSource([entry('ruling', 'She answers before he finishes.')]);

    expect(source).toMatch(/your next response must honour this/i);
});

test('a note is labelled too, rather than rendering as bare prose', () => {
    // A bare line in a block of instructions reads as text to reproduce. This
    // is the type the Director writes most of, and it was the only one with no
    // label at all.
    const source = buildDirectorNotesSource([entry('note', 'The radiator thumped.')]);

    expect(source).toMatch(/do not restate it/i);
    expect(source).not.toMatch(/^- The radiator thumped\.$/m);
});

test('every type the performer can see carries an instruction — structurally', () => {
    // The guard that matters: a type added to NARRATOR_VISIBLE_TYPES without a
    // label would render bare, and bare is the shape that gets reproduced.
    for (const type of NARRATOR_VISIBLE_TYPES) {
        const source = buildDirectorNotesSource([entry(type, 'Distinctive body text.')]);
        const line = source.split('\n').find((item) => item.includes('Distinctive body text.'));

        expect(line).toBeTruthy();
        expect(line.replace('- ', '').startsWith('Distinctive body text.')).toBe(false);
    }
});

test('an empty notebook produces nothing at all, not a bare header', () => {
    expect(buildDirectorNotesSource([])).toBe('');
    expect(buildDirectorNotesSource([entry('note', '   ')])).toBe('');
});

// --- frameDirectorReasoning: the reasoning-to-Narrator bridge ----------------

test('frameDirectorReasoning prepends the director-awareness header to raw reasoning', () => {
    const reasoning = 'Teo has been dodging for three turns and Eli is about to snap.';
    const result = frameDirectorReasoning(reasoning);

    expect(result).toContain('scene director');
    expect(result).toContain('creative thinking');
    expect(result).toContain('Ignore any technical references');
    expect(result).toContain(reasoning);
});

test('frameDirectorReasoning returns empty string for falsy reasoning', () => {
    expect(frameDirectorReasoning('')).toBe('');
    expect(frameDirectorReasoning(null)).toBe('');
    expect(frameDirectorReasoning(undefined)).toBe('');
});

test('frameDirectorReasoning passes the full reasoning without truncation or filtering', () => {
    const mechanical = '[ruling] If Eli sits, Teo talks.\n|||STATE_FENCE|||\nvariable.adjust: mood +2\n|||END_FENCE|||';
    const result = frameDirectorReasoning(mechanical);

    expect(result).toContain('[ruling]');
    expect(result).toContain('|||STATE_FENCE|||');
    expect(result).toContain('variable.adjust: mood +2');
});
