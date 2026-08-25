import {
    buildCultivationPacket,
    cultivationSearchText,
    draftCultivationProposal,
    inspectCultivationConflicts,
    seedProtectionSummary,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-cultivation.js';

const seed = { book: 'Vesper', uid: '1', name: 'The egg', keys: ['yolk egg'], secondaryKeys: ['parasite'], content: 'Identity\nAn alien egg.\n\nEstablished\nThe egg is dormant.\n\nOpen threads\nIts origin is unknown.' };
const metadata = { book: 'Vesper', uid: '1', entryType: 'seed', revision: 4, protectedFields: ['identity', 'established'] };

test('drafts pointed seed growth without gaining write authority', () => {
    expect(draftCultivationProposal({ action: 'grow', book: 'Vesper', entry: seed, metadata, value: 'What wakes the egg?' })).toEqual({
        ok: true,
        proposal: expect.objectContaining({ operation: 'thread.add', section: 'Open threads', target: { book: 'Vesper', uid: '1', revision: 4 }, entryType: 'seed', confidence: 1, value: 'What wakes the egg?' }),
    });
});

test('builds a minimal revisioned packet for create, edit, and link previews', () => {
    const target = { book: 'Vesper', uid: '2', name: 'Vesper House', keys: ['Vesper House'], secondaryKeys: [], content: 'A sorority house.', metadata: { book: 'Vesper', uid: '2', entryType: 'entity', revision: 2 } };
    const drafted = draftCultivationProposal({ action: 'link', book: 'Vesper', entry: seed, metadata, linkTarget: target, relation: 'contained by' });
    const packet = buildCultivationPacket({ timelineId: 'tl', book: 'Vesper', entries: [seed, target], metadata: [metadata, target.metadata], proposal: drafted.proposal });
    expect(packet.entries.map((item) => item.target.uid)).toEqual(['1', '2']);
    expect(drafted.proposal.value).toEqual({ target: { book: 'Vesper', uid: '2', revision: 2 }, relation: 'contained-by' });
});

test('find-related queries stay bounded and deterministic', () => {
    expect(cultivationSearchText(seed)).toContain('yolk egg');
    expect(cultivationSearchText({ ...seed, content: 'x'.repeat(5000) }).length).toBeLessThan(1400);
});

test('warns about duplicate keys, duplicate claims, and opposite-polarity claims', () => {
    const warnings = inspectCultivationConflicts([
        seed,
        { book: 'Vesper', uid: '2', name: 'Duplicate', keys: ['Yolk Egg'], content: 'The egg is dormant.' },
        { book: 'Vesper', uid: '3', name: 'Conflict', keys: ['hatchery'], content: 'The egg is not dormant.' },
    ], seed);
    expect(warnings.map((item) => item.kind)).toEqual(expect.arrayContaining(['duplicate-key', 'duplicate-claim', 'possible-contradiction']));
});

test('summarizes seed section locks from ordinary protected fields', () => {
    expect(seedProtectionSummary(metadata)).toEqual({ premiseProtected: true, currentProtected: false, hooksProtected: false });
});
