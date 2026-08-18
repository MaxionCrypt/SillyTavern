import { parseDirectorReply } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/director-reply.js';
import { appendDirectorEntries, readNarratorEntries, readAllEntriesForOwner } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/director-notes-store.js';
import { __setExtensionSettings } from './util/st-context-stub.js';

// Regression: a real Director reply, captured from the owner's debug export on
// 2026-08-17, that the line-leading `/^\[([a-z]+)\]/` parser could not read.
//
// It parsed as ONE entry of type `note`, and because `readNarratorEntries`
// withholds by TYPE, both `[secret]` entries were then sent to the Narrator
// under the heading "established by the hidden director; treat as settled
// fact". The secret type's entire value is that it never reaches the
// performer. This file exists so a formatting change in the model cannot
// quietly repeal that again.

const TIMELINE = 'timeline-markdown';
const SCENE = 'scene-markdown';

beforeEach(() => {
    __setExtensionSettings({ remodel: {} });
});

// Verbatim shape from the export: a list marker on the first tag, bold
// wrappers on all of them, markdown's two-space soft breaks at line ends.
const REPLY = `- **[note]** the late-afternoon October flat-light slants through a second-floor window
**[note]** Teo is kneeling on a mattress that groans with every shift of his weight
**[result]** Teo grins — all incisors — and says, "Don't 'Really Teo' me, I know what I'm doing."

**[secret]** the skinsuit is not inert — the membrane is laced with a slow-acting psycho-resonant compound that bonds to the first wearer's nervous system
**[secret]** the Goal "Teo trying on the Other Skin" is currently at 50%`;

test('bold, list-prefixed tags parse as four typed entries, not one note', () => {
    const { entries } = parseDirectorReply(REPLY);

    expect(entries.map((entry) => entry.type)).toEqual(['note', 'note', 'result', 'secret', 'secret']);
    expect(entries[0].text).toMatch(/^the late-afternoon/);
    expect(entries[2].text).toMatch(/^Teo grins/);
    expect(entries[3].text).toMatch(/^the skinsuit is not inert/);
});

test('the secrets in that reply never reach the Narrator', () => {
    const { entries } = parseDirectorReply(REPLY);
    appendDirectorEntries(TIMELINE, { sceneId: SCENE, turn: 1, entries });

    const narrator = readNarratorEntries(TIMELINE, { sceneId: SCENE, depth: 3 }).map((entry) => entry.text).join('\n');
    expect(narrator).toMatch(/Teo grins/);
    expect(narrator).not.toMatch(/psycho-resonant/);
    expect(narrator).not.toMatch(/currently at 50%/);

    // And the Director still keeps them, because it owns them.
    const owner = readAllEntriesForOwner(TIMELINE, { sceneId: SCENE }).map((entry) => entry.text).join('\n');
    expect(owner).toMatch(/psycho-resonant/);
});

test('the tag survives every wrapper a model reaches for', () => {
    const shapes = [
        '[note] bare',
        '**[note]** bold',
        '*[note]* italic',
        '__[note]__ underscores',
        '- [note] list marker',
        '1. **[note]** numbered and bold',
        '[NOTE] uppercase',
        '**[note]**: trailing colon',
        // The wrapper opened before the tag and closed after the TEXT, which
        // is what a model writing markdown does at least as often as wrapping
        // the label alone. The tag regex cannot consume that closing pair —
        // it is past the end of the tag — so tidy() is what removes it.
        '**[note] bold across the whole entry**',
        '_[note] underscored across the whole entry_',
    ];
    for (const shape of shapes) {
        const { entries } = parseDirectorReply(shape);
        expect(entries).toHaveLength(1);
        expect(entries[0].type).toBe('note');
        // The wrapper is consumed, never left in the stored text.
        expect(entries[0].text).not.toMatch(/[[\]*_]/);
    }
});

test('a whole reply on one line still splits, because line position is not the signal', () => {
    const { entries } = parseDirectorReply('**[note]** he waits **[ruling]** she answers first **[secret]** the door is already locked');

    expect(entries.map((entry) => entry.type)).toEqual(['note', 'ruling', 'secret']);
    expect(entries[2].text).toBe('the door is already locked');
});

test('a tag with nothing after it is dropped rather than stored as a blank entry', () => {
    // Models emit stray tags — a heading they thought better of, a trailing
    // tag before the state fence. Storing them would put empty bullets in the
    // Narrator's notes block and empty rows in the owner's notebook.
    const { entries } = parseDirectorReply('**[note]**\n**[ruling]** she answers first\n**[secret]**   ');

    expect(entries.map((entry) => entry.type)).toEqual(['ruling']);
});

test('an emphasised unknown tag is withheld rather than absorbed - REVERSED deliberately', () => {
    // Was: `**[observation]**` stayed inside the note above it. An unrecognised
    // label now becomes `unknown`, which the performer never sees, because a
    // label inheriting a note's visibility is how a secret escaped.
    const { entries } = parseDirectorReply('**[note]** real\n**[observation]** not a type');

    expect(entries.map((entry) => entry.type)).toEqual(['note', 'unknown']);
    expect(entries[0].text).toBe('real');
    expect(entries[1].type).toBe('unknown');
});

test('prose before the first tag is kept as a note rather than dropped', () => {
    const { entries } = parseDirectorReply('Thinking about the room first.\n**[ruling]** she answers first');

    expect(entries.map((entry) => entry.type)).toEqual(['note', 'ruling']);
    expect(entries[0].text).toBe('Thinking about the room first.');
});
