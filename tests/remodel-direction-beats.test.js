import { deriveBeats } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/direction-beats.js';

const kinds = (text) => deriveBeats(text).map((beat) => beat.kind);
const offsets = (text) => deriveBeats(text).map((beat) => beat.offset);

test('a breath follows each sentence terminator', () => {
    const text = 'He stopped. She waited.';
    expect(offsets(text)).toEqual([12, 23]);
    expect(kinds(text)).toEqual(['breath', 'breath']);
});

test('a paragraph break is an opening, not a breath', () => {
    const text = 'He stopped.\n\nShe waited.';
    const beats = deriveBeats(text);
    expect(beats.some((beat) => beat.kind === 'opening')).toBe(true);
});

test('abbreviations do not create a beat', () => {
    expect(deriveBeats('Dr. Veyr waited.')).toHaveLength(1);
});

test('an ellipsis is one beat, not three', () => {
    expect(deriveBeats('He hesitated... then moved.')).toHaveLength(2);
});

test('dialogue closing punctuation carries the beat past the quote', () => {
    const text = '"Stop," she said. He did.';
    expect(offsets(text)).toEqual([18, 25]);
});

test('offsets never exceed the text length and always ascend', () => {
    const text = 'One. Two! Three? Four.';
    const list = offsets(text);
    expect(Math.max(...list)).toBeLessThanOrEqual(text.length);
    expect([...list].sort((a, b) => a - b)).toEqual(list);
});

test('text with no terminator yields no beats', () => {
    expect(deriveBeats('a fragment with no end')).toEqual([]);
});

test('empty input is safe', () => {
    expect(deriveBeats('')).toEqual([]);
});
