import {
    WORLD_SENSE_OWNS_ACTIVATION,
    worldInfoRecursionAllowed,
    worldInfoScanCorpus,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/world-sense-scan-authority.js';

const CHAT = ['She asks about Queens Lake University.', 'Marissa looked up from the table.'];

test('the switch is on, so World Sense decides what the Narrator sees', () => {
    // If this is ever flipped, every expectation below inverts. It is the one
    // place to change, which is the point of the module.
    expect(WORLD_SENSE_OWNS_ACTIVATION).toBe(true);
});

test('a scanner is given nothing to match against', () => {
    expect(worldInfoScanCorpus(CHAT)).toEqual([]);
});

test('recursion is refused even when the user has it switched on natively', () => {
    // Emptying the corpus alone is not enough: a constant entry activates with
    // no scan text at all, and native recursion would then match its content
    // against every key in the book and pull in the whole neighbourhood.
    expect(worldInfoRecursionAllowed(true)).toBe(false);
    expect(worldInfoRecursionAllowed(false)).toBe(false);
});

test('a missing corpus is handled rather than thrown at', () => {
    expect(worldInfoScanCorpus()).toEqual([]);
    expect(worldInfoScanCorpus(undefined)).toEqual([]);
});
