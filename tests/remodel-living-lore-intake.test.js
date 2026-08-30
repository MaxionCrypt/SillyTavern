import {
    DEFAULT_INTAKE_THRESHOLD,
    DEFAULT_TEMPORAL_HALF_LIFE_HOURS,
    placeLivingLoreInformation,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-intake.js';

const HOUR = 3600000;
const NOW = 1756500000000; // fixed: placement must not depend on wall clock

const entry = (uid, name, keys, content) => ({ book: 'B', uid: String(uid), name, keys, secondaryKeys: [], content, native: {} });
const meta = (uid, createdAt) => ({ book: 'B', uid: String(uid), createdAt });
const sim = (pairs) => Object.entries(pairs).map(([uid, score]) => ({ book: 'B', uid, score }));

// Halloway names Teo, so they are neighbours in the mesh. The Vault is
// unrelated to both and nothing names it.
const ENTRIES = [
    entry(1, 'Halloway Residence', ['Halloway'], 'A house that Teo visits.'),
    entry(2, 'Teo Alvarez', ['Teo'], 'A student.'),
    entry(3, 'The Vault', ['Vault'], 'A sealed room under the library.'),
];
const METADATA = [meta(1, NOW), meta(2, NOW), meta(3, NOW - (24 * 30 * HOUR))];

const place = (overrides = {}) => placeLivingLoreInformation({
    entries: ENTRIES, metadata: METADATA, recordedAt: NOW, ...overrides,
});

test('information about an entry’s neighbourhood is appended to it', () => {
    const result = place({
        content: 'Teo left his coat at Halloway.',
        semanticMatches: sim({ 1: 0.6, 2: 0.5, 3: 0.0 }),
    });
    expect(result.decision).toBe('append');
    expect(result.target.name).toBe('Halloway Residence');
});

test('the header is what gets dropped: an append names a target, never a new entry', () => {
    const result = place({ content: 'Teo left his coat at Halloway.', semanticMatches: sim({ 1: 0.9 }) });
    expect(result.decision).toBe('append');
    expect(result.target).toMatchObject({ book: 'B', uid: '1' });
});

test('unrelated information becomes its own entry', () => {
    const result = place({
        content: 'A courier from another city refuses to say who sent her.',
        semanticMatches: sim({ 1: 0.05, 2: 0.05, 3: 0.05 }),
    });
    expect(result.decision).toBe('create');
    expect(result.reason).toBe('below-threshold');
    expect(result.target).toBeNull();
});

test('a weighted score lets one strong signal carry a weak one', () => {
    // Names nothing and is a month away from the Vault's creation, but is a
    // near-perfect semantic match. Weighted scoring must still consider it.
    const weak = place({ content: 'A sealed room under the library.', semanticMatches: sim({ 3: 0.99 }) });
    // ...and must not admit it on that alone, because 0.3 * 0.99 < 0.5.
    expect(weak.decision).toBe('create');

    // With the weights inverted it does carry, which is what "weighted" means.
    const carried = place({
        content: 'A sealed room under the library.',
        semanticMatches: sim({ 3: 0.99 }),
        weights: { semantic: 1, recursive: 0, temporal: 0 },
    });
    expect(carried.decision).toBe('append');
    expect(carried.target.name).toBe('The Vault');
});

test('time is measured from creation, so appending cannot make the next append likelier', () => {
    // The Vault was created a month ago but was appended to seconds ago. If
    // placement scored updatedAt, that append would make the next one likelier
    // and a long scene would collapse into this one entry. Both timestamps are
    // present so the assertion can only pass by reading createdAt.
    const touched = [meta(1, NOW), meta(2, NOW), { book: 'B', uid: '3', createdAt: NOW - (24 * 30 * HOUR), updatedAt: NOW }];
    const result = placeLivingLoreInformation({
        content: 'Vault.', entries: ENTRIES, metadata: touched, recordedAt: NOW, semanticMatches: sim({ 3: 0.4 }),
    });
    const vault = result.candidates.find((item) => item.name === 'The Vault');
    expect(vault.signals.temporal).toBeLessThan(0.01);
});

test('recent information about a fresh entry scores temporally, stale does not', () => {
    const fresh = place({ content: 'Halloway.', semanticMatches: sim({ 1: 0.3 }) })
        .candidates.find((item) => item.name === 'Halloway Residence');
    const stale = place({ content: 'Halloway.', recordedAt: NOW + (DEFAULT_TEMPORAL_HALF_LIFE_HOURS * 4 * HOUR), semanticMatches: sim({ 1: 0.3 }) })
        .candidates.find((item) => item.name === 'Halloway Residence');
    expect(fresh.signals.temporal).toBeGreaterThan(0.9);
    expect(stale.signals.temporal).toBeLessThan(0.1);
});

test('the recursive signal measures what the content names, not neighbourhood size', () => {
    // Content naming only Teo is entirely about Teo's part of the mesh, so
    // Halloway — Teo's neighbour — must not be penalised for having neighbours.
    const result = place({ content: 'Teo said nothing.', semanticMatches: [] });
    const halloway = result.candidates.find((item) => item.name === 'Halloway Residence');
    const vault = result.candidates.find((item) => item.name === 'The Vault');
    expect(halloway.signals.recursive).toBe(1);
    expect(vault.signals.recursive).toBe(0);
});

test('content that names nothing scores zero recursively rather than dividing by zero', () => {
    const result = place({ content: 'Something happened somewhere.', semanticMatches: [] });
    expect(result.candidates.every((item) => item.signals.recursive === 0)).toBe(true);
    expect(result.decision).toBe('create');
});

test('an entry with no recorded creation time earns no temporal closeness', () => {
    const result = placeLivingLoreInformation({
        content: 'Teo.', entries: ENTRIES, metadata: [], recordedAt: NOW, semanticMatches: [],
    });
    expect(result.candidates.every((item) => item.signals.temporal === 0)).toBe(true);
});

test('a missing recordedAt is not treated as the epoch', () => {
    for (const empty of [null, undefined, '', 0, 'not a date']) {
        const result = place({ content: 'Teo.', recordedAt: empty, semanticMatches: [] });
        expect(result.candidates.every((item) => item.signals.temporal === 0)).toBe(true);
    }
});

test('an ISO timestamp is accepted as readily as epoch millis', () => {
    const iso = place({ content: 'Halloway.', recordedAt: new Date(NOW).toISOString(), semanticMatches: sim({ 1: 0.3 }) });
    const epoch = place({ content: 'Halloway.', recordedAt: NOW, semanticMatches: sim({ 1: 0.3 }) });
    expect(iso.candidates[0].signals.temporal).toBe(epoch.candidates[0].signals.temporal);
});

test('an empty book or empty content creates rather than throwing', () => {
    expect(placeLivingLoreInformation({ content: 'x', entries: [] }).decision).toBe('create');
    expect(placeLivingLoreInformation({ content: '', entries: ENTRIES }).reason).toBe('empty-content');
});

test('every candidate it weighed is reported, best first', () => {
    const result = place({ content: 'Teo left his coat at Halloway.', semanticMatches: sim({ 1: 0.6 }) });
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates[0].score).toBeGreaterThanOrEqual(result.candidates[1].score);
    expect(result.threshold).toBe(DEFAULT_INTAKE_THRESHOLD);
});

test('a disabled entry is not a placement target', () => {
    const disabled = [{ ...ENTRIES[0], native: { disable: true } }, ...ENTRIES.slice(1)];
    const result = placeLivingLoreInformation({
        content: 'Teo left his coat at Halloway.', entries: disabled, metadata: METADATA,
        recordedAt: NOW, semanticMatches: sim({ 1: 0.9 }),
    });
    expect(result.candidates.some((item) => item.name === 'Halloway Residence')).toBe(false);
});

test('weights are relative, so they need not add up to one', () => {
    // Only the ratio between the signals is meaningful. These weights sum to
    // 0.1; if they were used as given, every score would be a tenth of what it
    // should be and nothing would ever clear the threshold.
    const result = place({
        content: 'A sealed room under the library.',
        semanticMatches: sim({ 3: 0.99 }),
        weights: { semantic: 0.1, recursive: 0, temporal: 0 },
    });
    expect(result.decision).toBe('append');
    expect(result.target.name).toBe('The Vault');
});

test('weights that are all zero fall back rather than dividing by zero', () => {
    const result = place({
        content: 'Teo left his coat at Halloway.',
        semanticMatches: sim({ 1: 0.6 }),
        weights: { semantic: 0, recursive: 0, temporal: 0 },
    });
    expect(Number.isFinite(result.candidates[0].score)).toBe(true);
});
