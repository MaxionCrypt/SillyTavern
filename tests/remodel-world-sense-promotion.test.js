import {
    buildWorldSensePromotionPacket,
    formatWorldSensePromotionPacket,
    parsePromotionDecisions,
    promotionEvidence,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/world-sense-promotion.js';

const livingLore = {
    book: 'Vox Dominus',
    entries: [{
        target: { book: 'Vox Dominus', uid: '12', revision: 3 },
        name: 'Miles Carter', keys: ['Miles'], secondaryKeys: ['Aiden roommate'], entryType: 'entity',
    }],
};

const scenes = [
    {
        sceneId: 'story-prologue',
        events: [{ id: 'e1', summary: 'Miles Carter hid the Gold Squad letter beneath the sink.' }],
        facts: { roommate: { key: 'roommate', value: 'Miles Carter shares Aiden room.' } },
        charStates: { miles: { charId: 'Miles Carter', facets: { trust: 'Miles distrusts the Gold Squad.' } } },
        beat: { directive: 'The Gold Squad letter may expose Miles.' }, secrets: {},
    },
    {
        sceneId: 'roleplay-one',
        events: [{ id: 'e2', summary: 'A Gold Squad observer followed Miles Carter through Vesper Hall.' }],
        facts: { roommate: { key: 'roommate', value: 'Miles Carter remains Aiden roommate.' } },
        charStates: {}, beat: { directive: 'Miles must decide what to do about the Gold Squad letter.' }, secrets: {},
    },
];

test('detects selected-entry updates, recurring entities, stable facts, and persistent threads without writing lore', () => {
    const packet = buildWorldSensePromotionPacket({ timelineId: 'vox', sceneId: 'roleplay-one', livingLore, scenes });
    expect(packet.protocol).toBe('world-sense.promotion-candidates.v1');
    expect(packet.candidates).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'selected-entry-update', subject: 'Miles Carter', target: livingLore.entries[0].target }),
        expect.objectContaining({ kind: 'recurring-entity', subject: 'Gold Squad' }),
        expect.objectContaining({ kind: 'stable-fact', subject: 'roommate' }),
        expect.objectContaining({ kind: 'persistent-thread' }),
    ]));
    expect(packet.candidates.length).toBeLessThanOrEqual(8);
    expect(promotionEvidence(packet).every((item) => item.summary && item.id)).toBe(true);
    expect(formatWorldSensePromotionPacket(packet)).toContain('promotion candidates');
});

test('decision receipts account for every bounded candidate', () => {
    const packet = buildWorldSensePromotionPacket({ timelineId: 'vox', livingLore, scenes });
    const first = packet.candidates[0];
    const parsed = parsePromotionDecisions([
        { candidateId: first.id, decision: 'deferred', reason: 'The Archive pattern is real but not yet durable enough.' },
    ], packet);
    expect(parsed.accepted).toEqual([expect.objectContaining({ candidateId: first.id, decision: 'deferred' })]);
    expect(parsed.rejected.filter((item) => item.code === 'missing-decision')).toHaveLength(packet.candidates.length - 1);
});
