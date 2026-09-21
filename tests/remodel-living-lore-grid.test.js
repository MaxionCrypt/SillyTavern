import { collectKeywords, keywordKind, buildKeywordGrid, resolveEntryForKeywords } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-grid.js';

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

const KINDED = [
    { tags: ['Rayse'], secret: false },
    { tags: ['Hidden'], secret: true },          // only a secret entry uses "Hidden"
    { tags: ['Rayse', 'goal'], secret: false },  // "goal" is a reserved marker
    { tags: ['variable'], secret: false },
    { tags: ['Shared'], secret: true },
    { tags: ['Shared'], secret: false },          // "Shared" is used by a visible entry too
];

test('keyword kind flags reserved markers and secret-only keywords', () => {
    expect(keywordKind('Rayse', KINDED)).toBe('normal');
    expect(keywordKind('Hidden', KINDED)).toBe('secret');
    expect(keywordKind('goal', KINDED)).toBe('goal');
    expect(keywordKind('variable', KINDED)).toBe('variable');
    expect(keywordKind('Shared', KINDED)).toBe('normal'); // shared with a non-secret entry
});

test('the grid tags each slot with its keyword kind', () => {
    const byKw = Object.fromEntries(
        buildKeywordGrid(KINDED).slots.filter((s) => s.keyword).map((s) => [s.keyword, s.kind]),
    );
    expect(byKw.Rayse).toBe('normal');
    expect(byKw.Hidden).toBe('secret');
    expect(byKw.goal).toBe('goal');
    expect(byKw.variable).toBe('variable');
});

test('secret entries are excluded from resolution when includeSecret is false', () => {
    const entries = [
        { uid: 's', title: 'Secret', tags: ['Hidden'], secret: true },
        { uid: 'n', title: 'Open', tags: ['Rayse'], secret: false },
    ];
    expect(resolveEntryForKeywords(entries, ['Hidden']).uid).toBe('s');                       // timeline sees it
    expect(resolveEntryForKeywords(entries, ['Hidden'], { includeSecret: false })).toBeNull(); // scene hides it
    expect(resolveEntryForKeywords(entries, ['Rayse'], { includeSecret: false }).uid).toBe('n');
});
