import {
    buildWorldSenseDryRun,
    filterWorldSenseWorkspaceEntries,
    proposalDiffRows,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/world-sense-workspace-model.js';

const entries = [
    { book: 'Marches', uid: '1', name: 'Old Harbor', keys: ['harbor'], secondaryKeys: ['docks'], content: 'The guild controls shipping.' },
    { book: 'Marches', uid: '2', name: 'Mara Vale', keys: ['Mara'], secondaryKeys: [], content: 'A courier.' },
];

const metadata = [
    { book: 'Marches', uid: '1', entryType: 'situation', revision: 3, worldSense: { excluded: false, pinned: false } },
    { book: 'Marches', uid: '2', entryType: 'entity', revision: 1, worldSense: { excluded: true, pinned: false } },
];

const receipt = {
    selected: [{ book: 'Marches', uid: '1', score: 92, decision: 'selected', reasons: [{ channel: 'semantic', similarity: 0.81 }, { channel: 'goal.link' }] }],
    rejected: [{ book: 'Marches', uid: '2', score: 0, decision: 'no-evidence', reasons: [] }],
    budget: { usedEntries: 1, maxEntries: 12, usedTokens: 75, maxTokens: 1800 },
};

test('workspace filtering combines text, type, and retrieval status', () => {
    expect(filterWorldSenseWorkspaceEntries({ entries, metadata, receipt, query: 'shipping', type: 'situation', status: 'selected' }))
        .toEqual([expect.objectContaining({ uid: '1', selected: true, score: 92 })]);
    expect(filterWorldSenseWorkspaceEntries({ entries, metadata, receipt, status: 'excluded' }))
        .toEqual([expect.objectContaining({ uid: '2', excluded: true })]);
});

test('dry run contains only selected lore and keeps exact retrieval reasons', () => {
    const packet = buildWorldSenseDryRun({ entries, metadata, receipt });
    expect(packet.entries).toHaveLength(1);
    expect(packet.entries[0]).toMatchObject({ uid: '1', revision: 3, reasons: ['semantic 81%', 'goal link'] });
    expect(packet.budget).toEqual(receipt.budget);
});

test('proposal diffs become field-level review rows', () => {
    expect(proposalDiffRows({
        diff: [
            { field: 'content', before: 'Old', after: 'New' },
            { field: 'keysecondary', before: ['dock'], after: ['dock', 'harbor'] },
        ],
    })).toEqual([
        { field: 'content', before: 'Old', after: 'New' },
        { field: 'keysecondary', before: '["dock"]', after: '["dock","harbor"]' },
    ]);
});
