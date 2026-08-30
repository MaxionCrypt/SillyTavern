import { describeEntryConnections, describeLoreConnections } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/world-sense-connections.js';
import { probeWorldSenseKeywords } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/world-sense-retrieval.js';

const entry = (uid, name, keys, content, native = {}) => ({ book: 'B', uid: String(uid), name, keys, secondaryKeys: [], content, native });

// Hub names Alpha and Beta. Nothing names Gamma, and Gamma names nothing.
const ENTRIES = [
    entry(1, 'Hub', ['Hub'], 'Hub concerns Alpha and Beta.'),
    entry(2, 'Alpha', ['Alpha'], 'Alpha is quiet.'),
    entry(3, 'Beta', ['Beta'], 'Beta is quiet.'),
    entry(4, 'Gamma', ['Gamma'], 'Gamma is quiet.'),
];
const of = (name) => describeLoreConnections(ENTRIES).find((item) => item.name === name);

test('a connection reports the key that actually caused it', () => {
    const link = of('Hub').neighbours.find((item) => item.name === 'Alpha');
    expect(link).toMatchObject({ relation: 'names', via: 'Alpha' });
});

test('being named is shown from the other side too', () => {
    expect(of('Alpha').neighbours.find((item) => item.name === 'Hub')).toMatchObject({ relation: 'named-by' });
});

test('two entries named together are shown as co-mentioned', () => {
    expect(of('Alpha').neighbours.find((item) => item.name === 'Beta')).toMatchObject({ relation: 'co-mentioned' });
});

test('an entry nothing connects to is reported as isolated', () => {
    expect(of('Gamma')).toMatchObject({ isolated: true, neighbours: [] });
    expect(of('Hub').isolated).toBe(false);
});

test('a non-recursable entry shows no connections, matching what the walk would do', () => {
    const blocked = [ENTRIES[0], { ...ENTRIES[1], native: { excludeRecursion: true } }, ...ENTRIES.slice(2)];
    const alpha = describeLoreConnections(blocked).find((item) => item.name === 'Alpha');
    expect(alpha.neighbours.some((item) => item.name === 'Hub')).toBe(false);
});

test('one entry can be asked about on its own', () => {
    expect(describeEntryConnections(ENTRIES[1], ENTRIES)).toMatchObject({ name: 'Alpha', isolated: false });
});

test('an entry outside the book answers rather than throwing', () => {
    expect(describeEntryConnections({ book: 'B', uid: '99', name: 'Ghost' }, ENTRIES)).toMatchObject({ isolated: true, neighbours: [] });
});

test('a keyword probe brings out what naming that keyword would bring out', () => {
    const result = probeWorldSenseKeywords({ keywords: ['Hub'], entries: ENTRIES, semanticAvailable: false });
    const names = result.candidates.map((candidate) => candidate.entry.name);
    expect(names).toContain('Hub');      // seeded by the keyword
    expect(names).toContain('Alpha');    // one hop out
    expect(names).not.toContain('Gamma'); // nothing connects it
});

test('a probe with no keywords returns nothing rather than the whole book', () => {
    expect(probeWorldSenseKeywords({ keywords: [], entries: ENTRIES })).toMatchObject({ candidates: [], terms: [] });
    expect(probeWorldSenseKeywords({ keywords: '   ', entries: ENTRIES }).candidates).toEqual([]);
});

test('a probe accepts a comma separated string the way it would be typed', () => {
    const result = probeWorldSenseKeywords({ keywords: 'Hub, Gamma', entries: ENTRIES, semanticAvailable: false });
    expect(result.terms).toEqual(['Hub', 'Gamma']);
    expect(result.candidates.map((candidate) => candidate.entry.name)).toContain('Gamma');
});

test('a probe names what vouched for an entry rather than printing its uid', async () => {
    const { describeWorldSenseReasons, nameReasonSources } = await import('../public/scripts/extensions/third-party/SillyTavern-Remodel/world-sense-workspace-model.js');
    const result = probeWorldSenseKeywords({ keywords: ['Hub'], entries: ENTRIES, semanticAvailable: false });
    const alpha = result.candidates.find((candidate) => candidate.entry.name === 'Alpha');
    const byKey = new Map(ENTRIES.map((item) => [`${item.book}.${item.uid}`, item]));
    const [text] = describeWorldSenseReasons(nameReasonSources(alpha.reasons, byKey));
    expect(text).toContain('via Hub');
    expect(text).not.toContain('via 1');
});

test('a co-mention names the entry that joined the two, not either one’s own key', () => {
    // Hub names Alpha and Beta. What connects Alpha to Beta is Hub — saying
    // "through Beta" would only tell the reader what Beta is called.
    const link = of('Alpha').neighbours.find((item) => item.name === 'Beta');
    expect(link).toMatchObject({ relation: 'co-mentioned', through: 'Hub' });
    expect(link.via).toBe('');
});

test('a direct naming still quotes the key that caused it', () => {
    const link = of('Hub').neighbours.find((item) => item.name === 'Alpha');
    expect(link).toMatchObject({ relation: 'names', via: 'Alpha' });
});

test('two entries co-mentioned by different entries each name their own mediator', () => {
    const entries = [
        entry(1, 'Hub', ['Hub'], 'Hub concerns Alpha and Beta.'),
        entry(2, 'Alpha', ['Alpha'], 'Alpha is quiet.'),
        entry(3, 'Beta', ['Beta'], 'Beta is quiet.'),
        entry(5, 'Other', ['Other'], 'Other concerns Alpha and Delta.'),
        entry(6, 'Delta', ['Delta'], 'Delta is quiet.'),
    ];
    const alpha = describeLoreConnections(entries).find((item) => item.name === 'Alpha');
    expect(alpha.neighbours.find((item) => item.name === 'Beta').through).toBe('Hub');
    expect(alpha.neighbours.find((item) => item.name === 'Delta').through).toBe('Other');
});
