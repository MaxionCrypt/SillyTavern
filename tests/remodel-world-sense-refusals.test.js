import {
    buildWorldSenseRefusals,
    describeLoreTier,
    describeWorldSenseReasons,
    describeWorldSenseRefusal,
    filterWorldSenseWorkspaceEntries,
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

test('a mention reason names the entry that vouched for it, not its uid', () => {
    const entries = [
        { book: 'Book', uid: '7', name: 'Halloway Residence', keys: ['Halloway Residence'], secondaryKeys: [], content: '' },
        { book: 'Book', uid: '9', name: 'Room 4B', keys: ['Room 4B'], secondaryKeys: [], content: '' },
    ];
    const receipt = {
        selected: [{ book: 'Book', uid: '9', score: 900, reasons: [{ channel: 'mention', depth: 1, from: 'Book::7', key: 'Halloway Residence' }] }],
        rejected: [],
    };
    const [row] = filterWorldSenseWorkspaceEntries({ entries, receipt }).filter((item) => item.key === 'Book.9');
    const [text] = describeWorldSenseReasons(row.reasons);
    expect(text).toContain('via Halloway Residence');
    expect(text).not.toContain('via 7');
});

test('a general entry says which layer of the hierarchy it came from', () => {
    const [text] = describeWorldSenseReasons([{ channel: 'general', tier: 0 }]);
    expect(text).toBe('broad in the hierarchy');
    expect(describeWorldSenseReasons([{ channel: 'general', tier: 1 }])[0]).toBe('mid-level in the hierarchy');
});

test('the most specific band is silent rather than labelled', () => {
    // Tier 2 scores nothing, so calling it out would imply a reason it did not have.
    expect(describeLoreTier(2)).toBe('');
    expect(describeLoreTier(null)).toBe('');
});

test('a missing tier is not silently coerced into the broadest band', () => {
    // Number(null), Number('') and Number([]) are all 0, which would label an
    // entry that has no place in the hierarchy as the broadest thing in it.
    for (const empty of [null, undefined, '', [], {}, NaN, '0']) {
        expect(describeLoreTier(empty)).toBe('');
    }
    expect(describeLoreTier(0)).toBe('broad');
});
