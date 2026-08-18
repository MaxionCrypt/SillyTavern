import { parseDirectorReply, NARRATOR_VISIBLE_TYPES } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/director-reply.js';
import { appendDirectorEntries, readNarratorEntries, readAllEntriesForOwner } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/director-notes-store.js';
import { __setExtensionSettings } from './util/st-context-stub.js';

// Secrecy must fail CLOSED. The denylist it replaces could only withhold what
// it already knew to name, so a secret the Director spelled differently was
// never typed `secret`, was never caught, and reached the performer under
// "treat as settled fact" — unrecoverably, because a spoiled twist cannot be
// un-spoiled.

const TIMELINE = 'timeline-secrecy';
const SCENE = 'scene-secrecy';

beforeEach(() => { __setExtensionSettings({ remodel: {} }); });

function narratorSees(reply) {
    const { entries } = parseDirectorReply(reply);
    appendDirectorEntries(TIMELINE, { sceneId: SCENE, turn: 1, entries });
    return readNarratorEntries(TIMELINE, { sceneId: SCENE, depth: 5 }).map((entry) => entry.text).join('\n');
}

test('the exact failure from the owner\'s turn 4: "Secret:" with no brackets', () => {
    const reply = [
        '[note] the cafe has gone grey toward evening',
        'Secret: the copper ring is cursed and Teo does not know',
    ].join('\n');

    const seen = narratorSees(reply);
    expect(seen).toContain('gone grey toward evening');
    expect(seen).not.toContain('copper ring');
});

test.each([
    ['[secret] ', '[secret] the ring is cursed'],
    ['**[secret]**', '**[secret]** the ring is cursed'],
    ['[SECRET]', '[SECRET] the ring is cursed'],
    ['Secret:', 'Secret: the ring is cursed'],
    ['secret:', 'secret: the ring is cursed'],
    ['- Secret —', '- Secret — the ring is cursed'],
])('a secret written as %s never reaches the performer', (_label, line) => {
    expect(narratorSees(`[note] the light is grey\n${line}`)).not.toContain('cursed');
});

test('a tag-shaped word we do not recognise is withheld, not merged into the note above', () => {
    // The whole point of the allowlist: an invented label must not inherit the
    // visibility of whatever entry preceded it.
    const seen = narratorSees('[note] the light is grey\n[hidden] the ring is cursed');

    expect(seen).toContain('the light is grey');
    expect(seen).not.toContain('cursed');
});

test('the owner still sees everything that was withheld', () => {
    const { entries } = parseDirectorReply('[note] the light is grey\nSecret: the ring is cursed\n[hidden] and so is the box');
    appendDirectorEntries(TIMELINE, { sceneId: SCENE, turn: 1, entries });

    const owner = readAllEntriesForOwner(TIMELINE, { sceneId: SCENE }).map((entry) => entry.text).join('\n');
    expect(owner).toContain('cursed');
    expect(owner).toContain('and so is the box');
});

test('prose is not shredded by the new shapes', () => {
    // Each of these would cut a note in half if the bracketless and unknown
    // forms were matched anywhere rather than only at a line start.
    const reply = [
        '[note] he would not say the secret: he only looked at the door',
        'she read it [sic] twice before speaking',
        'Teo: I know what I am doing',
    ].join('\n');

    const seen = narratorSees(reply);
    expect(seen).toContain('he only looked at the door');
    expect(seen).toContain('[sic] twice');
    expect(seen).toContain('Teo: I know what I am doing');
});

test('multi-line secrets stay whole and stay withheld', () => {
    const seen = narratorSees([
        '[secret] the ring is cursed',
        'and the curse answers to blood',
        '[note] the radiator thumped',
    ].join('\n'));

    expect(seen).not.toContain('cursed');
    expect(seen).not.toContain('answers to blood');
    expect(seen).toContain('radiator thumped');
});

test('the allowlist names only the three performer-safe types', () => {
    expect([...NARRATOR_VISIBLE_TYPES].sort()).toEqual(['note', 'result', 'ruling']);
});
