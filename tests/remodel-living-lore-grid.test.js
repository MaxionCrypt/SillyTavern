import { collectKeywords, keywordKind, buildKeywordGrid, resolveEntryForKeywords } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-grid.js';

test('keyword kind flags reserved markers only (case-insensitive)', () => {
    expect(keywordKind('secret')).toBe('secret');
    expect(keywordKind('Goal')).toBe('goal');
    expect(keywordKind('VARIABLE')).toBe('variable');
    expect(keywordKind('Rayse')).toBe('normal');
});

test('collectKeywords dedupes A→Z and assigns primary/secondary roles', () => {
    const list = collectKeywords([
        { tags: ['Delta', 'Alpha'] },
        { tags: ['Charlie'], secondaryTags: ['Bravo'] },
        { tags: ['alpha'] },
    ]);
    expect(list.map((k) => k.keyword)).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);
    const role = Object.fromEntries(list.map((k) => [k.keyword, k.role]));
    expect(role.Alpha).toBe('primary');
    expect(role.Charlie).toBe('primary');
    expect(role.Bravo).toBe('secondary');
});

test('keywords fill the lattice in down-left diagonal order (alphabetical along it)', () => {
    const { slots, keywords } = buildKeywordGrid([
        { tags: ['Delta', 'Alpha'] },
        { tags: ['Charlie'] },
        { tags: ['bravo'] },
    ]);
    expect(keywords.map((k) => k.keyword)).toEqual(['Alpha', 'bravo', 'Charlie', 'Delta']);
    const diag = (s) => s.cx / 52 + s.cy / 62;
    const placed = slots.slice()
        .sort((a, b) => diag(a) - diag(b) || a.cy - b.cy || a.cx - b.cx)
        .map((s) => s.keyword)
        .filter(Boolean);
    expect(placed).toEqual(['Alpha', 'bravo', 'Charlie', 'Delta']);
});

test('the grid grows sideways for many keywords and places every one', () => {
    const many = buildKeywordGrid([{ tags: Array.from({ length: 24 }, (_v, i) => `kw${String(i).padStart(2, '0')}`) }]);
    expect(new Set(many.slots.map((s) => s.cx)).size).toBeGreaterThan(5);
    expect(many.slots.filter((s) => s.keyword).length).toBe(24);
});

// --- Primary OR + Secondary AND resolution ----------------------------------

test('primary keys are OR — any one selected reveals the entry', () => {
    const one = [{ uid: 'x', tags: ['A', 'B'] }];
    expect(resolveEntryForKeywords(one, ['A']).uid).toBe('x');
    expect(resolveEntryForKeywords(one, ['B']).uid).toBe('x');
});

test('secondary keys are AND — they must also be selected', () => {
    const e = [{ uid: 'y', tags: ['A'], secondaryTags: ['B'] }];
    expect(resolveEntryForKeywords(e, ['A'])).toBeNull();
    expect(resolveEntryForKeywords(e, ['A', 'B']).uid).toBe('y');
});

const OR_AND = [
    { uid: 'or', title: 'A or B', tags: ['A', 'B'] },                 // primary OR
    { uid: 'and', title: 'A and B', tags: ['A'], secondaryTags: ['B'] }, // A primary + B secondary
];

test('"A or B" and "A and B" (same keyword union) are told apart', () => {
    expect(resolveEntryForKeywords(OR_AND, ['A']).uid).toBe('or');      // the AND entry needs B
    expect(resolveEntryForKeywords(OR_AND, ['B']).uid).toBe('or');
    expect(resolveEntryForKeywords(OR_AND, ['A', 'B']).uid).toBe('and'); // more constrained wins
});

test('a selection with an unrelated keyword resolves to nothing', () => {
    expect(resolveEntryForKeywords(OR_AND, ['A', 'Z'])).toBeNull();
    expect(resolveEntryForKeywords(OR_AND, [])).toBeNull();
});

test('matching is case-insensitive', () => {
    expect(resolveEntryForKeywords(OR_AND, ['a', 'b']).uid).toBe('and');
});

// --- Secret marker + hiding -------------------------------------------------

test('a secret entry contributes one "secret" marker slot, not tinted topic keywords', () => {
    const entries = [{ tags: ['Rayse'], secret: false }, { tags: ['Ashfall'], secret: true }];
    const kinds = (grid) => Object.fromEntries(grid.slots.filter((s) => s.keyword).map((s) => [s.keyword, s.kind]));
    const timeline = kinds(buildKeywordGrid(entries));
    expect(timeline.Rayse).toBe('normal');
    expect(timeline.Ashfall).toBe('normal');   // the secret entry's own keyword stays normal
    expect(timeline.secret).toBe('secret');    // one reserved marker slot
});

test('the Scene view hides secret entries’ own keywords but keeps the secret marker', () => {
    const entries = [{ tags: ['Rayse'], secret: false }, { tags: ['Ashfall'], secret: true }];
    const scene = Object.fromEntries(
        buildKeywordGrid(entries, { hideSecret: true }).slots.filter((s) => s.keyword).map((s) => [s.keyword, s.kind]),
    );
    expect(scene.Rayse).toBe('normal');
    expect(scene.secret).toBe('secret');
    expect(scene.Ashfall).toBeUndefined();     // the secret entry's keyword is gone
});

test('secret entries are excluded from resolution when includeSecret is false', () => {
    const entries = [
        { uid: 's', tags: ['Hidden'], secret: true },  // primary keys: Hidden + secret
        { uid: 'n', tags: ['Rayse'], secret: false },
    ];
    expect(resolveEntryForKeywords(entries, ['Hidden']).uid).toBe('s');
    expect(resolveEntryForKeywords(entries, ['Hidden'], { includeSecret: false })).toBeNull();
    expect(resolveEntryForKeywords(entries, ['Rayse'], { includeSecret: false }).uid).toBe('n');
});
