import {
    buildLivingLorePacket,
    formatLivingLorePacket,
    parseLivingLoreProposals,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-proposals.js';

const entries = [
    { book: 'Timeline Book', uid: '42', name: 'Marissa', keys: ['Marissa'], secondaryKeys: ['Riss'], content: 'Established: Marissa studies history.\nCurrent: She is in the cafe.' },
    { book: 'Timeline Book', uid: '99', name: 'Old Harbor', keys: ['Old Harbor'], secondaryKeys: [], content: 'A tidal port.' },
];

const packet = () => buildLivingLorePacket({
    timelineId: 'tl-1',
    book: 'Timeline Book',
    bookHash: 'book-hash',
    entries,
    selected: [{ book: 'Timeline Book', uid: '42', reasons: [{ channel: 'action.primary' }] }],
    metadata: [{ book: 'Timeline Book', uid: '42', revision: 7, entryType: 'entity', protectedFields: ['identity'] }],
});

const proposal = (patch = {}) => ({
    operation: 'current.set',
    target: { book: 'Timeline Book', uid: '42', revision: 7 },
    entryType: 'entity',
    section: 'Current',
    value: 'Marissa has left the cafe for the archive.',
    evidence: 'Marissa closed her notebook and crossed the street to the archive.',
    confidence: 0.91,
    reason: 'Accepted prose changes her current location.',
    ...patch,
});

test('builds a bounded Loom packet from selected entries only, with revisions', () => {
    const result = packet();
    expect(result).toMatchObject({ timelineId: 'tl-1', book: 'Timeline Book', bookHash: 'book-hash' });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
        target: { book: 'Timeline Book', uid: '42', revision: 7 },
        name: 'Marissa',
        entryType: 'entity',
        protectedFields: ['identity'],
    });
    expect(result.entries[0].content).toContain('Marissa studies history');
    expect(formatLivingLorePacket(result)).toContain('"revision": 7');
    expect(formatLivingLorePacket(result)).not.toContain('Old Harbor');
});

test('accepts a typed change against the exact selected revision without applying it', () => {
    const result = parseLivingLoreProposals([proposal()], packet());
    expect(result.accepted).toEqual([proposal()]);
    expect(result.rejected).toEqual([]);
});

test.each([
    ['arbitrary replacement', proposal({ operation: 'entry.replace' }), 'unsupported-operation'],
    ['wrong book', proposal({ target: { book: 'Another Book', uid: '42', revision: 7 } }), 'wrong-book'],
    ['stale revision', proposal({ target: { book: 'Timeline Book', uid: '42', revision: 6 } }), 'stale-revision'],
    ['unselected entry', proposal({ target: { book: 'Timeline Book', uid: '99', revision: 1 } }), 'unselected-target'],
])('rejects %s', (_label, candidate, code) => {
    const result = parseLivingLoreProposals([candidate], packet());
    expect(result.accepted).toEqual([]);
    expect(result.rejected[0]).toMatchObject({ code });
});

test('entry.create may address the Timeline book but cannot smuggle a replacement target', () => {
    const create = proposal({
        operation: 'entry.create',
        target: { book: 'Timeline Book' },
        entryType: 'situation',
        section: 'Established',
        value: 'The archive closes at midnight.',
    });
    expect(parseLivingLoreProposals([create], packet()).accepted).toEqual([create]);
    expect(parseLivingLoreProposals([{ ...create, target: { book: 'Timeline Book', uid: '42', revision: 7 } }], packet()).rejected[0])
        .toMatchObject({ code: 'create-target-exists' });
});
