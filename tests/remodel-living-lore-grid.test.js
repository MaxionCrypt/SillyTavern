import { collectKeywords, buildKeywordGrid, resolveEntryForKeywords } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-grid.js';

test('keywords are deduped case-insensitively (first casing) and sorted A→Z', () => {
    const kws = collectKeywords([
        { tags: ['Delta', 'Alpha'] },
        { tags: ['charlie', 'ALPHA'] },
        { tags: ['bravo'] },
    ]);
    expect(kws).toEqual(['Alpha', 'bravo', 'charlie', 'Delta']);
});

test('keywords fill the lattice in down-left diagonal order (alphabetical along it)', () => {
    const { slots, keywords } = buildKeywordGrid([
        { tags: ['Delta', 'Alpha'] },
        { tags: ['Charlie'] },
        { tags: ['bravo', 'Alpha'] },
    ]);
    expect(keywords).toEqual(['Alpha', 'bravo', 'Charlie', 'Delta']);
    // Read placed keywords in the same down-left diagonal order the builder uses.
    const diag = (s) => s.cx / 52 + s.cy / 62;
    const placed = slots.slice()
        .sort((a, b) => diag(a) - diag(b) || a.cy - b.cy || a.cx - b.cx)
        .map((s) => s.keyword)
        .filter(Boolean);
    expect(placed).toEqual(keywords);
});

test('the grid grows sideways when there are many keywords, and never fewer than 5 columns', () => {
    const few = buildKeywordGrid([{ tags: ['one', 'two'] }]);
    const many = buildKeywordGrid([{ tags: Array.from({ length: 24 }, (_v, i) => `kw${String(i).padStart(2, '0')}`) }]);
    const cols = (grid) => new Set(grid.slots.map((s) => s.cx)).size;
    expect(cols(few)).toBeGreaterThanOrEqual(5);          // 5 cols + the notch column
    expect(cols(many)).toBeGreaterThan(cols(few));        // grew to fit 24 keywords
    // Every keyword lands on a slot.
    expect(many.slots.filter((s) => s.keyword).length).toBe(24);
});

const ENTRIES = [
    { uid: '1', title: 'Rayse', tags: ['Rayse'] },
    { uid: '2', title: 'Rayse Abilities', tags: ['Rayse', 'Abilities'] },
    { uid: '3', title: 'The Gate', tags: ['Iron Gate', 'the gate'] },
];

test('an exact keyword-set selection resolves to its entry', () => {
    expect(resolveEntryForKeywords(ENTRIES, ['Rayse', 'Abilities']).uid).toBe('2');
});

test('a keyword shared by several entries resolves to the one with the fewest extra keywords', () => {
    // "Rayse" is entry 1 (exact, 0 extra) and entry 2 (1 extra) → entry 1.
    expect(resolveEntryForKeywords(ENTRIES, ['Rayse']).uid).toBe('1');
});

test('a superset selection with no exact match still resolves to the containing entry', () => {
    expect(resolveEntryForKeywords(ENTRIES, ['the gate']).uid).toBe('3');
});

test('matching is case-insensitive', () => {
    expect(resolveEntryForKeywords(ENTRIES, ['rayse', 'ABILITIES']).uid).toBe('2');
});

test('an unmatched or empty selection resolves to null', () => {
    expect(resolveEntryForKeywords(ENTRIES, ['Nope'])).toBeNull();
    expect(resolveEntryForKeywords(ENTRIES, [])).toBeNull();
    expect(resolveEntryForKeywords(ENTRIES, ['Rayse', 'the gate'])).toBeNull(); // no entry has both
});
