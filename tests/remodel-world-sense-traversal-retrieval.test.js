import {
    buildWorldSenseQueryPacket,
    scoreLivingLoreCandidatesByTraversal,
    selectWorldSenseCandidates,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/world-sense-retrieval.js';

const entry = (uid, name, keys, content = '', native = {}) => ({
    book: 'Book', uid: String(uid), name, keys, secondaryKeys: [], content, native,
});

// Piper is named in the scene. Piper's entry mentions the Warden. The Warden's
// entry mentions the Charter. Nothing mentions the Almanac.
const ENTRIES = [
    entry(1, 'Piper', ['Piper'], 'A runner who answers to the Warden.'),
    entry(2, 'The Warden', ['Warden'], 'Keeps the Charter.'),
    entry(3, 'The Charter', ['Charter'], 'The old agreement.'),
    entry(4, 'The Almanac', ['Almanac'], 'A book of tides.'),
];
const PACKET = buildWorldSenseQueryPacket({ action: 'Piper runs for the door.' });
const semantic = (pairs) => Object.entries(pairs).map(([uid, score], index) => ({ book: 'Book', uid, score, rank: index }));
const keys = (result) => result.candidates.map((candidate) => candidate.key).sort();
const channelsFor = (result, key) => result.candidates.find((c) => c.key === key)?.reasons.map((r) => r.channel) || [];

test('the scene naming an entry seeds it, whatever its similarity', () => {
    const result = scoreLivingLoreCandidatesByTraversal({
        packet: PACKET, entries: ENTRIES, semanticMatches: [],
    });
    expect(keys(result)).toContain('Book.1');
    expect(channelsFor(result, 'Book.1')).toContain('action.primary');
});

test('a mention is followed and a good score admits it', () => {
    const result = scoreLivingLoreCandidatesByTraversal({
        packet: PACKET, entries: ENTRIES, semanticMatches: semantic({ 2: 0.9 }),
    });
    expect(keys(result)).toContain('Book.2');
    expect(channelsFor(result, 'Book.2')).toContain('mention');
});

test('a mention with a poor score is refused, and says so', () => {
    const result = scoreLivingLoreCandidatesByTraversal({
        packet: PACKET, entries: ENTRIES, semanticMatches: semantic({ 2: 0.01 }),
    });
    expect(keys(result)).not.toContain('Book.2');
    expect(result.rejected.find((item) => item.key === 'Book.2').decision).toBe('below-gate');
});

test('similarity alone never admits an entry nothing mentions', () => {
    const result = scoreLivingLoreCandidatesByTraversal({
        packet: PACKET, entries: ENTRIES, semanticMatches: semantic({ 4: 0.99 }),
    });
    // This is the whole inversion: the Almanac is the best semantic match in
    // the book and is still not selected, because nothing refers to it.
    expect(keys(result)).not.toContain('Book.4');
});

test('no lore candidate is ever semantic-only, so that cap has nothing to cap', () => {
    const result = scoreLivingLoreCandidatesByTraversal({
        packet: PACKET, entries: ENTRIES, semanticMatches: semantic({ 2: 0.9, 3: 0.9 }),
    });
    for (const candidate of result.candidates) {
        const onlySemantic = candidate.reasons.length > 0
            && candidate.reasons.every((reason) => reason.channel === 'semantic');
        expect(onlySemantic).toBe(false);
    }
});

test('a pin forces an entry in with no mention and no score', () => {
    const result = scoreLivingLoreCandidatesByTraversal({
        packet: PACKET, entries: ENTRIES, semanticMatches: [], pins: [{ book: 'Book', uid: '4' }],
    });
    const almanac = result.candidates.find((candidate) => candidate.key === 'Book.4');
    expect(almanac.forced).toBe(true);
    expect(almanac.reasons.map((reason) => reason.channel)).toContain('pin');
});

test('a constant entry is forced in the same way', () => {
    const withConstant = [...ENTRIES.slice(0, 3), entry(4, 'The Almanac', ['Almanac'], 'A book of tides.', { constant: true })];
    const result = scoreLivingLoreCandidatesByTraversal({ packet: PACKET, entries: withConstant, semanticMatches: [] });
    expect(result.candidates.find((candidate) => candidate.key === 'Book.4').forced).toBe(true);
});

test('an excluded or disabled entry is outside traversal entirely', () => {
    const disabled = [entry(1, 'Piper', ['Piper'], 'Answers to the Warden.', { disable: true }), ...ENTRIES.slice(1)];
    expect(keys(scoreLivingLoreCandidatesByTraversal({ packet: PACKET, entries: disabled, semanticMatches: [] }))).toEqual([]);

    const excluded = scoreLivingLoreCandidatesByTraversal({
        packet: PACKET, entries: ENTRIES, semanticMatches: [],
        metadata: [{ book: 'Book', uid: '1', worldSense: { excluded: true } }],
    });
    expect(keys(excluded)).toEqual([]);
});

test('a seed outranks a mention, which outranks a distant mention', () => {
    const result = scoreLivingLoreCandidatesByTraversal({
        packet: PACKET, entries: ENTRIES, semanticMatches: semantic({ 2: 0.9, 3: 0.9 }),
    });
    const score = (key) => result.candidates.find((candidate) => candidate.key === key).score;
    expect(score('Book.1')).toBeGreaterThan(score('Book.2'));
    expect(score('Book.2')).toBeGreaterThan(score('Book.3'));
});

test('it hands the budgeter candidates it can spend on', () => {
    const result = scoreLivingLoreCandidatesByTraversal({
        packet: PACKET, entries: ENTRIES, semanticMatches: semantic({ 2: 0.9 }),
    });
    const ranking = selectWorldSenseCandidates(result.candidates, { budget: { maxEntries: 1, maxTokens: 9999 } });
    expect(ranking.selected).toHaveLength(1);
    expect(ranking.selected[0].uid).toBe('1'); // the seed, not the mention
    expect(ranking.rejected[0].decision).toBe('entry-budget');
});

test('an empty book produces nothing rather than throwing', () => {
    const result = scoreLivingLoreCandidatesByTraversal({ packet: PACKET, entries: [], semanticMatches: [] });
    expect(result).toEqual({ candidates: [], rejected: [], receipt: null });
});
