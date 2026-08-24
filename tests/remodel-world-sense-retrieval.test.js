import { buildWorldSenseQueryPacket, canReuseWorldSensePrefetch, rankLivingLore } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/world-sense-retrieval.js';

const entry = (uid, name, keys, content = '', native = {}) => ({ book: 'Book', uid: String(uid), name, keys, secondaryKeys: [], content, native });

test('builds a bounded stable query that distinguishes Continue pressure', () => {
    const first = buildWorldSenseQueryPacket({ action: '[Continue the scene from accepted history.]', openThread: 'The bell is still ringing.', goals: [{ title: 'Reach the gate', description: 'Before dusk' }] });
    const same = buildWorldSenseQueryPacket({ action: '[Continue the scene from accepted history.]', openThread: 'The bell is still ringing.', goals: [{ title: 'Reach the gate', description: 'Before dusk' }] });
    const changed = buildWorldSenseQueryPacket({ action: '[Continue the scene from accepted history.]', openThread: 'The bell has stopped.' });
    expect(first.hash).toBe(same.hash);
    expect(changed.hash).not.toBe(first.hash);
    expect(first.text).toContain('[Open thread]');
    expect(first.text).toContain('[Goal pressures]');
});

test('reuses composer work only for the exact query hash inside its TTL', () => {
    const cached = { queryHash: 'same', createdAt: 1000 };
    expect(canReuseWorldSensePrefetch(cached, 'same', 2000, 5000)).toBe(true);
    expect(canReuseWorldSensePrefetch(cached, 'changed', 2000, 5000)).toBe(false);
    expect(canReuseWorldSensePrefetch(cached, 'same', 7000, 5000)).toBe(false);
});

test('deduplicates hybrid evidence and keeps inspectable reasons', () => {
    const packet = buildWorldSenseQueryPacket({ action: 'Marissa runs toward Old Harbor.', cast: [{ label: 'Marissa' }] });
    const result = rankLivingLore({
        packet,
        entries: [entry(1, 'Old Harbor', ['Old Harbor'], 'A tidal port.'), entry(2, 'Unrelated', ['Moon'])],
        semanticMatches: [{ book: 'Book', uid: '1', rank: 0 }],
        goals: [{ id: 'g1', title: 'Escape', loreLinks: [{ book: 'Book', uid: '1', type: 'stake' }] }],
    });
    expect(result.selected).toHaveLength(1);
    expect(result.selected[0].reasons.map((reason) => reason.channel)).toEqual(expect.arrayContaining(['semantic', 'action.primary', 'goal.link']));
    expect(result.propagation.goalIds).toEqual(['g1']);
});

test('honors token and entry budgets while constants and pins remain selected', () => {
    const packet = buildWorldSenseQueryPacket({ action: 'gate harbor market' });
    const result = rankLivingLore({
        packet,
        entries: [
            entry(1, 'Rule', [], 'x'.repeat(100), { constant: true }),
            entry(2, 'Gate', ['gate'], 'x'.repeat(100)),
            entry(3, 'Harbor', ['harbor'], 'x'.repeat(100)),
            entry(4, 'Market', ['market'], 'x'.repeat(100)),
        ],
        pins: [{ book: 'Book', uid: '4' }],
        budget: { maxEntries: 1, maxTokens: 10 },
    });
    expect(result.selected.map((item) => item.uid)).toEqual(['4', '1']);
    expect(result.budget.overflow).toBe(true);
    expect(result.rejected.some((item) => item.decision.includes('budget'))).toBe(true);
});

test('falls back deterministically when semantic candidates are absent', () => {
    const packet = buildWorldSenseQueryPacket({ archive: [{ key: 'location', value: 'glasshouse' }] });
    const result = rankLivingLore({ packet, entries: [entry(1, 'Glasshouse', ['glasshouse']), entry(2, 'Docks', ['docks'])], semanticMatches: [] });
    expect(result.selected.map((item) => item.uid)).toEqual(['1']);
    expect(result.rejected[0]).toMatchObject({ uid: '2', decision: 'no-evidence' });
});
