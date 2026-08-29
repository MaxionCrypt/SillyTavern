import {
    assignLoreTiers,
    buildLoreMentionGraph,
    loreKeyMatches,
    measureKeyBreadth,
    scoreLoreGenerality,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/lore-hierarchy.js';

const entry = (uid, name, keys, content, native = {}) => ({
    book: 'Book', uid, name, keys, secondaryKeys: [], content, native,
});

// A faction everyone refers to, a district that refers to it, and one incident
// that refers to the district. General at the top, specific at the bottom.
const BOOK = [
    entry('1', 'The Warden', ['Warden'], 'The authority that polices this coast.'),
    entry('2', 'Old Harbour', ['harbour', 'old harbour'], 'A district watched by the Warden.'),
    entry('3', 'The gate incident', ['gate incident'], 'Piper slipped past the old harbour checkpoint while the Warden looked away.'),
];

// ---------------------------------------------------------------- matching ---

test('single-word keys match on word boundaries, as core does', () => {
    expect(loreKeyMatches('The Warden watched.', 'Warden')).toBe(true);
    expect(loreKeyMatches('Wardens watched.', 'Warden')).toBe(false);
    expect(loreKeyMatches('the warden watched', 'Warden')).toBe(true);
});

test('case sensitivity is honoured per entry', () => {
    expect(loreKeyMatches('the warden', 'Warden', { caseSensitive: true })).toBe(false);
    expect(loreKeyMatches('the Warden', 'Warden', { caseSensitive: true })).toBe(true);
});

test('multi-word keys fall back to substring matching, as core does', () => {
    expect(loreKeyMatches('past the old harbour checkpoint', 'old harbour')).toBe(true);
    expect(loreKeyMatches('past the old harbours', 'old harbour')).toBe(true);
});

test('a regex key is used as a regex, not as literal slashes', () => {
    expect(loreKeyMatches('the Warden-General spoke', '/warden-\\w+/i')).toBe(true);
    expect(loreKeyMatches('the Warden spoke', '/warden-\\w+/i')).toBe(false);
    expect(loreKeyMatches('anything', '/[unclosed/')).toBe(false);
});

test('an empty or blank key never matches', () => {
    expect(loreKeyMatches('text', '')).toBe(false);
    expect(loreKeyMatches('text', '   ')).toBe(false);
});

// ------------------------------------------------------------------- graph ---

test('an edge runs from the mentioning entry to the mentioned one', () => {
    const { edges } = buildLoreMentionGraph(BOOK);
    expect(edges).toContainEqual(expect.objectContaining({ from: 'Book::2', to: 'Book::1', key: 'Warden' }));
    expect(edges).toContainEqual(expect.objectContaining({ from: 'Book::3', to: 'Book::2' }));
});

test('being mentioned raises in-degree; mentioning others does not', () => {
    const { inDegree, outDegree } = buildLoreMentionGraph(BOOK);
    expect(inDegree.get('Book::1')).toBe(2); // both others name the Warden
    expect(inDegree.get('Book::3')).toBe(0); // nothing refers to the incident
    expect(outDegree.get('Book::3')).toBe(2);
});

test('an entry never mentions itself', () => {
    const selfish = [entry('1', 'Warden', ['Warden'], 'The Warden is the Warden.')];
    expect(buildLoreMentionGraph(selfish).inDegree.get('Book::1')).toBe(0);
});

test('preventRecursion silences a source; excludeRecursion shields a target', () => {
    const silenced = buildLoreMentionGraph([
        BOOK[0], BOOK[1], { ...BOOK[2], native: { preventRecursion: true } },
    ]);
    expect(silenced.inDegree.get('Book::2')).toBe(0);

    const shielded = buildLoreMentionGraph([
        { ...BOOK[0], native: { excludeRecursion: true } }, BOOK[1], BOOK[2],
    ]);
    expect(shielded.inDegree.get('Book::1')).toBe(0);
});

test('disabled entries are outside the graph entirely', () => {
    const graph = buildLoreMentionGraph([{ ...BOOK[0], native: { disable: true } }, BOOK[1], BOOK[2]]);
    expect(graph.inDegree.has('Book::1')).toBe(false);
    expect(graph.edges.every((edge) => edge.to !== 'Book::1')).toBe(true);
});

// -------------------------------------------------------------- generality ---

test('key breadth counts distinct addresses, not repeats', () => {
    expect(measureKeyBreadth({ keys: ['Warden', 'warden', ' WARDEN '], secondaryKeys: ['authority'] })).toBe(2);
    expect(measureKeyBreadth({ keys: [], secondaryKeys: [] })).toBe(0);
});

test('the most-mentioned entry scores as the most general', () => {
    const scored = scoreLoreGenerality(BOOK);
    expect(scored[0].name).toBe('The Warden');
    expect(scored.at(-1).name).toBe('The gate incident');
    expect(scored[0].generality).toBeGreaterThan(scored.at(-1).generality);
});

test('generality is normalised into 0..1 against the book itself', () => {
    for (const item of scoreLoreGenerality(BOOK)) {
        expect(item.generality).toBeGreaterThanOrEqual(0);
        expect(item.generality).toBeLessThanOrEqual(1);
    }
});

test('a book where nothing refers to anything has no generality gradient', () => {
    const isolated = [entry('1', 'A', ['aaa'], 'nothing'), entry('2', 'B', ['bbb'], 'nothing')];
    expect(scoreLoreGenerality(isolated).every((item) => item.generality === 0)).toBe(true);
});

test('breadth lifts an entry nothing happens to mention', () => {
    const wide = entry('4', 'The Order', ['order', 'the order', 'wardens council', 'council'], 'Unmentioned.');
    const scored = scoreLoreGenerality([...BOOK, wide]);
    expect(scored.find((item) => item.name === 'The Order').generality)
        .toBeGreaterThan(scored.find((item) => item.name === 'The gate incident').generality);
});

test('weights are adjustable and mentions can be ignored entirely', () => {
    const breadthOnly = scoreLoreGenerality(BOOK, { mentionWeight: 0, breadthWeight: 1 });
    expect(breadthOnly[0].name).toBe('Old Harbour'); // two keys beats one
});

// ------------------------------------------------------------------- tiers ---

test('tier 0 is the most general and tiers are bounded', () => {
    const tiered = assignLoreTiers(scoreLoreGenerality(BOOK), { tiers: 3 });
    expect(tiered[0].tier).toBe(0);
    for (const item of tiered) {
        expect(item.tier).toBeGreaterThanOrEqual(0);
        expect(item.tier).toBeLessThanOrEqual(2);
    }
});

test('entries scoring identically always share a tier', () => {
    const twins = [
        entry('1', 'A', ['aaa'], 'mentions ccc'),
        entry('2', 'B', ['bbb'], 'mentions ccc'),
        entry('3', 'C', ['ccc'], 'end'),
    ];
    const tiered = assignLoreTiers(scoreLoreGenerality(twins), { tiers: 3 });
    const a = tiered.find((item) => item.name === 'A');
    const b = tiered.find((item) => item.name === 'B');
    expect(a.generality).toBe(b.generality);
    expect(a.tier).toBe(b.tier);
});

test('a single tier collapses the hierarchy rather than erroring', () => {
    expect(assignLoreTiers(scoreLoreGenerality(BOOK), { tiers: 1 }).every((item) => item.tier === 0)).toBe(true);
});
