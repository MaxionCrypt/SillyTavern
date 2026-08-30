import {
    buildWorldSenseRefusals,
    describeWorldSenseRefusal,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/world-sense-workspace-model.js';

const entries = [
    { book: 'Book', uid: '1', name: 'Alchemy' },
    { book: 'Book', uid: '2', name: 'Cognito' },
    { book: 'Book', uid: '3', name: 'Equal Exchange' },
];

const receipt = {
    rejected: [
        { kind: 'lore', key: 'Book.3', name: 'Equal Exchange', decision: 'below-gate', depth: 1, similarity: 0.164, bar: 0.3, reasons: [{ channel: 'mention', from: 'Book::1', key: 'alchemy' }] },
        { kind: 'lore', key: 'Book.2', name: 'Cognito', decision: 'below-gate', depth: 1, similarity: 0.253, bar: 0.3, reasons: [{ channel: 'mention', from: 'Book::1', key: 'alchemy' }] },
        { kind: 'continuity', key: 'scene-9', decision: 'continuity-limit' },
    ],
};

test('every refusal reason reads as plain language', () => {
    expect(describeWorldSenseRefusal('below-gate')).toBe('scored too low');
    expect(describeWorldSenseRefusal('depth-exhausted')).toBe('too far from the scene');
    expect(describeWorldSenseRefusal('entry-budget')).toBe('no room left');
    expect(describeWorldSenseRefusal('token-budget')).toBe('no tokens left');
});

test('an unrecognised reason degrades to something readable rather than blank', () => {
    expect(describeWorldSenseRefusal('some-new-reason')).toBe('some new reason');
    expect(describeWorldSenseRefusal('')).toBe('refused');
    expect(describeWorldSenseRefusal(undefined)).toBe('refused');
});

test('the nearest miss is listed first', () => {
    const rows = buildWorldSenseRefusals({ entries, receipt });
    expect(rows.map((row) => row.name)).toEqual(['Cognito', 'Equal Exchange']);
    expect(rows[0].similarity).toBeCloseTo(0.253);
});

test('each row carries what vouched for it and the bar it missed', () => {
    const [nearest] = buildWorldSenseRefusals({ entries, receipt });
    // `via` is the NAME of the entry that proposed it, resolved from the graph
    // id. The raw id ends in a uid, which tells a reader nothing.
    expect(nearest).toMatchObject({
        name: 'Cognito', label: 'scored too low', depth: 1, bar: 0.3, via: 'Alchemy', viaKey: 'alchemy',
    });
});

test('an unresolvable voucher leaves the name blank rather than showing a uid', () => {
    const [row] = buildWorldSenseRefusals({
        entries: [],
        receipt: { rejected: [{ kind: 'lore', key: 'Book.2', name: 'Cognito', decision: 'below-gate', reasons: [{ channel: 'mention', from: 'Book::9', key: 'x' }] }] },
    });
    expect(row.via).toBe('');
});

test('continuity refusals are not shown as lore refusals', () => {
    expect(buildWorldSenseRefusals({ entries, receipt }).map((row) => row.key)).not.toContain('scene-9');
});

test('a refusal for an entry that has since vanished still names it', () => {
    const rows = buildWorldSenseRefusals({
        entries: [],
        receipt: { rejected: [{ kind: 'lore', key: 'Book.9', decision: 'unknown-entry' }] },
    });
    expect(rows[0]).toMatchObject({ name: 'Book.9', label: 'entry no longer exists' });
});

test('no receipt produces no rows rather than throwing', () => {
    expect(buildWorldSenseRefusals({ entries, receipt: null })).toEqual([]);
    expect(buildWorldSenseRefusals({})).toEqual([]);
});
