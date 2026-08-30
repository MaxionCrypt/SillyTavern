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

test('a degraded semantic pass falls back to mentions instead of refusing everything', () => {
    // Same book, no semantic matches at all — as when the local model times out.
    const degraded = scoreLivingLoreCandidatesByTraversal({
        packet: PACKET, entries: ENTRIES, semanticMatches: [], semanticAvailable: false,
    });
    // The Warden is mentioned by Piper, so it still comes through.
    expect(keys(degraded)).toContain('Book.2');

    // With the vector available and nothing scoring, the same input refuses it.
    const gated = scoreLivingLoreCandidatesByTraversal({
        packet: PACKET, entries: ENTRIES, semanticMatches: [], semanticAvailable: true,
    });
    expect(keys(gated)).not.toContain('Book.2');
});

test('the degraded fallback takes one ring only, never wandering deeper', () => {
    const degraded = scoreLivingLoreCandidatesByTraversal({
        packet: PACKET, entries: ENTRIES, semanticMatches: [], semanticAvailable: false,
    });
    // Charter is two mentions away; without a discriminator we do not guess.
    expect(keys(degraded)).not.toContain('Book.3');
    expect(degraded.candidates.every((candidate) => candidate.reasons.some((r) => r.channel === 'scene' || r.channel === 'mention'))).toBe(true);
});

// A book with a real general/specific split. The Harbour Authority is named by
// three other entries, so the mention graph rates it the broad idea; Locker 12
// is named by one and names nothing, so it is the specific one.
const TIERED = [
    entry(1, 'Piper', ['Piper'], 'A runner who answers to the Harbour Authority and keeps Locker 12.'),
    entry(2, 'The Warden', ['Warden'], 'Speaks for the Harbour Authority.'),
    entry(3, 'The Dock Ledger', ['Ledger'], 'Kept on behalf of the Harbour Authority.'),
    entry(4, 'Harbour Authority', ['Harbour Authority'], 'The body that runs the harbour.'),
    entry(5, 'Locker 12', ['Locker 12'], 'A dented steel locker.'),
];
const TIERED_PACKET = buildWorldSenseQueryPacket({ action: 'Piper runs for the door.' });

test('at equal distance the general entry outranks the specific one', () => {
    const result = scoreLivingLoreCandidatesByTraversal({
        packet: TIERED_PACKET, entries: TIERED,
        // Identical similarity, so only the hierarchy can separate them.
        semanticMatches: semantic({ 4: 0.9, 5: 0.9 }),
    });
    const score = (key) => result.candidates.find((c) => c.key === key)?.score ?? -1;
    expect(score('Book.4')).toBeGreaterThan(score('Book.5'));
    const reasons = result.candidates.find((c) => c.key === 'Book.4').reasons;
    expect(reasons.map((r) => r.channel)).toContain('general');
});

test('the hierarchy never outranks distance', () => {
    const result = scoreLivingLoreCandidatesByTraversal({
        packet: TIERED_PACKET, entries: TIERED, semanticMatches: semantic({ 4: 0.9, 5: 0.9, 2: 0.9 }),
    });
    const score = (key) => result.candidates.find((c) => c.key === key)?.score ?? -1;
    // Piper is the seed. However broad the Harbour Authority is, a depth-1
    // entry must never overtake the entry the scene actually named.
    expect(score('Book.1')).toBeGreaterThan(score('Book.4'));
});

test('a tier never buys admission the vector refused', () => {
    const result = scoreLivingLoreCandidatesByTraversal({
        packet: TIERED_PACKET, entries: TIERED,
        // The broadest entry in the book, scoring far below the gate.
        semanticMatches: semantic({ 4: 0.01 }),
    });
    expect(result.candidates.map((c) => c.key)).not.toContain('Book.4');
    expect(result.rejected.find((item) => item.key === 'Book.4').decision).toBe('below-gate');
});

test('a refusal carries the tier so the workspace can show which layer it was', () => {
    const result = scoreLivingLoreCandidatesByTraversal({
        packet: TIERED_PACKET, entries: TIERED, semanticMatches: semantic({ 4: 0.01 }),
    });
    expect(result.rejected.find((item) => item.key === 'Book.4').tier).toBe(0);
});

test('a seed is ranked by its scene match, not by the hierarchy', () => {
    // The scene names the Harbour Authority directly, so it is a seed AND the
    // broadest entry in the book. It must still earn no hierarchy points.
    const seededPacket = buildWorldSenseQueryPacket({ action: 'Piper reports to the Harbour Authority.' });
    const result = scoreLivingLoreCandidatesByTraversal({
        packet: seededPacket, entries: TIERED, semanticMatches: semantic({ 4: 0.9 }),
    });
    const authority = result.candidates.find((c) => c.key === 'Book.4');
    expect(authority.reasons.map((r) => r.channel)).toContain('action.primary');
    expect(authority.reasons.map((r) => r.channel)).not.toContain('general');
});

test('the same entry does earn hierarchy points when the walk reaches it', () => {
    // Identical book, but the scene names Piper instead, so the Harbour
    // Authority arrives one mention out rather than as a seed.
    const result = scoreLivingLoreCandidatesByTraversal({
        packet: TIERED_PACKET, entries: TIERED, semanticMatches: semantic({ 4: 0.9 }),
    });
    const authority = result.candidates.find((c) => c.key === 'Book.4');
    expect(authority.reasons.map((r) => r.channel)).toContain('general');
});
