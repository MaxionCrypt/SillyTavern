import { gateLoreTraversal } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/lore-traversal.js';
import { buildLoreMentionGraph } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/lore-hierarchy.js';

// scene → Piper → Warden → Charter, a chain three mentions deep.
const graph = {
    edges: [
        { from: 'piper', to: 'warden', key: 'Warden' },
        { from: 'warden', to: 'charter', key: 'Charter' },
        { from: 'charter', to: 'founding', key: 'Founding' },
        { from: 'piper', to: 'gate', key: 'gate' },
    ],
};
const known = new Set(['piper', 'warden', 'charter', 'founding', 'gate']);

const gateWith = (similarity, overrides = {}) => gateLoreTraversal({
    seeds: ['piper'], graph, similarity, known, ...overrides,
});

const idsAt = (result, depth) => result.admitted.filter((item) => item.depth === depth).map((item) => item.id).sort();
const reasonFor = (result, id) => result.rejected.find((item) => item.id === id)?.reason;

test('a seed is admitted on the scene naming it, without a similarity check', () => {
    const result = gateWith({ piper: 0 }); // scores zero and still gets in
    expect(idsAt(result, 0)).toEqual(['piper']);
    expect(result.admitted[0].via).toBeNull();
});

test('a mention proposes and a good score admits it', () => {
    const result = gateWith({ piper: 1, warden: 0.9, gate: 0.9 });
    expect(idsAt(result, 1)).toEqual(['gate', 'warden']);
    expect(result.admitted.find((item) => item.id === 'warden').via)
        .toEqual({ from: 'piper', key: 'Warden', relation: 'names' });
});

test('a poor score no longer refuses a connected entry', () => {
    // The vector is secondary. Something the world explicitly linked to what is
    // in play is not withheld because its wording sits far apart in meaning.
    const result = gateWith({ piper: 1, warden: 0.05, gate: 0.9 });
    expect(idsAt(result, 1)).toEqual(['gate', 'warden']);
    // Only the depth limit turns anything away; nothing is refused for scoring.
    expect(result.rejected.map((item) => item.reason)).toEqual(
        result.rejected.map(() => 'depth-exhausted'),
    );
});

test('the vector decides only when there is not room for everything', () => {
    const result = gateWith({ piper: 1, warden: 0.05, gate: 0.9 }, { maxEntries: 2 });
    expect(idsAt(result, 1)).toEqual(['gate']);
    expect(reasonFor(result, 'warden')).toBe('entry-budget');
});

test('an entry nothing mentions is never considered, however relevant it looks', () => {
    const result = gateLoreTraversal({
        seeds: ['piper'], graph, known, similarity: { piper: 1, founding: 0.99 },
    });
    // `founding` scores near-perfectly but is only reachable through charter.
    expect(result.admitted.map((item) => item.id)).not.toContain('founding');
});

test('distance, not similarity, decides who gets the budget first', () => {
    const result = gateLoreTraversal({
        seeds: ['piper'], graph, known, maxEntries: 2,
        // charter is two hops out and scores far better than either neighbour.
        similarity: { piper: 1, warden: 0.2, gate: 0.1, charter: 0.99 },
    });
    expect(idsAt(result, 1)).toEqual(['warden']);
    expect(result.admitted.map((item) => item.id)).not.toContain('charter');
});

test('a chain is still walkable when the caller asks for the depth', () => {
    const result = gateLoreTraversal({
        seeds: ['piper'], graph, known, maxDepth: 3,
        similarity: { piper: 1, warden: 0.95, charter: 0.95, founding: 0.95 },
    });
    expect(result.admitted.map((item) => item.id)).toEqual(
        expect.arrayContaining(['warden', 'charter', 'founding']),
    );
    expect(result.receipt.deepest).toBe(3);
});

test('naming runs both ways, so the walk can start from either end', () => {
    // Nothing names piper; piper names warden. Entering at warden must still
    // reach piper, because a reference says the two belong together.
    const result = gateLoreTraversal({ seeds: ['warden'], graph, known, similarity: {} });
    expect(idsAt(result, 1)).toContain('piper');
    expect(result.admitted.find((item) => item.id === 'piper').via.relation).toBe('named-by');
});

test('two things named by the same entry become neighbours', () => {
    // piper names both warden and gate. Neither names the other, but they were
    // put in the same entry, so they are connected through it.
    const result = gateLoreTraversal({ seeds: ['warden'], graph, known, maxDepth: 1, similarity: {} });
    expect(idsAt(result, 1)).toContain('gate');
    expect(result.admitted.find((item) => item.id === 'gate').via.relation).toBe('co-mentioned');
});

test('a new entry joins two existing subjects without either being edited', () => {
    // The note is new and nothing refers to it. It names two entries that had
    // no connection, and that alone makes them reachable from each other.
    const withNote = { edges: [...graph.edges, { from: 'note', to: 'gate', key: 'gate' }, { from: 'note', to: 'founding', key: 'Founding' }] };
    const result = gateLoreTraversal({
        seeds: ['gate'], graph: withNote, known: new Set([...known, 'note']), maxDepth: 1, similarity: {},
    });
    expect(result.admitted.map((item) => item.id)).toContain('founding');
    expect(result.admitted.find((item) => item.id === 'founding').via.relation).toBe('co-mentioned');
});

test('depth is bounded, and what was cut off says so', () => {
    const result = gateLoreTraversal({
        seeds: ['piper'], graph, known, maxDepth: 1,
        similarity: { piper: 1, warden: 0.99, charter: 0.99 },
    });
    expect(result.admitted.map((item) => item.id)).not.toContain('charter');
    expect(reasonFor(result, 'charter')).toBe('depth-exhausted');
});

test('"we stopped looking" is never reported as "we said no"', () => {
    const result = gateLoreTraversal({
        seeds: ['piper'], graph, known, maxDepth: 1,
        similarity: { piper: 1, warden: 0.99, charter: 0.01 },
    });
    // charter would also have failed the gate, but the honest reason is that
    // traversal ended before it was ever judged.
    expect(reasonFor(result, 'charter')).toBe('depth-exhausted');
});

test('the entry budget spends on the most relevant proposals first', () => {
    const result = gateLoreTraversal({
        seeds: ['piper'], graph, known, maxEntries: 2,
        similarity: { piper: 1, warden: 0.5, gate: 0.95 },
    });
    expect(idsAt(result, 1)).toEqual(['gate']); // higher score wins the one slot
    expect(reasonFor(result, 'warden')).toBe('entry-budget');
});

test('the token budget refuses rather than overruns', () => {
    const result = gateLoreTraversal({
        seeds: ['piper'], graph, known, maxTokens: 100,
        similarity: { piper: 1, warden: 0.9, gate: 0.9 },
        tokensFor: (id) => (id === 'piper' ? 60 : 60),
    });
    expect(result.receipt.tokens).toBeLessThanOrEqual(100);
    expect(result.rejected.some((item) => item.reason === 'token-budget')).toBe(true);
});

test('an entry is admitted once, by its closest connection', () => {
    const diamond = {
        edges: [
            { from: 'piper', to: 'warden', key: 'Warden' },
            { from: 'piper', to: 'gate', key: 'gate' },
            { from: 'gate', to: 'warden', key: 'Warden' },
        ],
    };
    const result = gateLoreTraversal({
        seeds: ['piper'], graph: diamond, known,
        similarity: { piper: 1, warden: 0.9, gate: 0.9 },
    });
    expect(result.admitted.filter((item) => item.id === 'warden')).toHaveLength(1);
    expect(result.admitted.find((item) => item.id === 'warden').depth).toBe(1);
});

test('a cycle terminates instead of looping', () => {
    const cycle = {
        edges: [
            { from: 'a', to: 'b', key: 'B' },
            { from: 'b', to: 'a', key: 'A' },
        ],
    };
    const result = gateLoreTraversal({
        seeds: ['a'], graph: cycle, known: new Set(['a', 'b']),
        similarity: { a: 1, b: 1 }, maxDepth: 10,
    });
    expect(result.admitted.map((item) => item.id).sort()).toEqual(['a', 'b']);
});

test('a mention of something that no longer exists is reported, not admitted', () => {
    const result = gateLoreTraversal({
        seeds: ['piper'], graph, known: new Set(['piper']),
        similarity: { piper: 1, warden: 0.99 },
    });
    expect(result.admitted.map((item) => item.id)).toEqual(['piper']);
    expect(reasonFor(result, 'warden')).toBe('unknown-entry');
});

test('the receipt accounts for every entry it considered', () => {
    const result = gateWith({ piper: 1, warden: 0.9, gate: 0.05 });
    expect(result.receipt.seeds).toBe(1);
    expect(result.receipt.admittedCount).toBe(result.admitted.length);
    expect(result.receipt.rejectedCount).toBe(result.rejected.length);
});

test('it composes with a graph built from real entries', () => {
    const entries = [
        { book: 'B', uid: '1', name: 'Piper', keys: ['Piper'], secondaryKeys: [], content: 'Answers to the Warden.', native: {} },
        { book: 'B', uid: '2', name: 'The Warden', keys: ['Warden'], secondaryKeys: [], content: 'Polices the coast.', native: {} },
    ];
    const built = buildLoreMentionGraph(entries);
    const result = gateLoreTraversal({
        seeds: ['B::1'], graph: built, known: new Set(['B::1', 'B::2']),
        similarity: { 'B::1': 1, 'B::2': 0.8 },
    });
    expect(result.admitted.map((item) => item.id)).toEqual(['B::1', 'B::2']);
});
