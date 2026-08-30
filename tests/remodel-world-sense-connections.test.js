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

test('an inbound reference is not shown as a connection', () => {
    // Hub names Alpha. The walk does not follow that backwards, so listing it
    // here would describe reachability the system does not have.
    expect(of('Alpha').neighbours.some((item) => item.name === 'Hub')).toBe(false);
    expect(of('Hub').neighbours.some((item) => item.name === 'Alpha')).toBe(true);
});

test('sharing a parent is not shown as a connection', () => {
    // Hub names Alpha and Beta. Hub is what connects them; they do not connect
    // to each other, and the walk does not treat them as if they did.
    expect(of('Alpha').neighbours.some((item) => item.name === 'Beta')).toBe(false);
    expect(of('Hub').neighbours.map((item) => item.name)).toEqual(['Alpha', 'Beta']);
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
    expect(describeEntryConnections(ENTRIES[0], ENTRIES)).toMatchObject({ name: 'Hub', isolated: false });
    // Alpha's content names nothing, so it reaches nothing.
    expect(describeEntryConnections(ENTRIES[1], ENTRIES)).toMatchObject({ name: 'Alpha', isolated: true });
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

test('a direct naming still quotes the key that caused it', () => {
    const link = of('Hub').neighbours.find((item) => item.name === 'Alpha');
    expect(link).toMatchObject({ relation: 'names', via: 'Alpha' });
});

