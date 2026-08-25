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

test('uses real similarity and caps entries supported by semantic evidence alone', () => {
    const packet = buildWorldSenseQueryPacket({ action: 'touch the amulet' });
    const entries = [
        entry(1, 'Relevant amulet', []),
        entry(2, 'Weakly related object', []),
        entry(3, 'First semantic extra', []),
        entry(4, 'Second semantic extra', []),
    ];
    const result = rankLivingLore({
        packet,
        entries,
        semanticMatches: [
            { book: 'Book', uid: '1', rank: 0, score: 0.72 },
            { book: 'Book', uid: '2', rank: 1, score: 0.21 },
            { book: 'Book', uid: '3', rank: 2, score: 0.61 },
            { book: 'Book', uid: '4', rank: 3, score: 0.56 },
        ],
        semanticThreshold: 0.35,
        semanticOnlyLimit: 2,
    });
    expect(result.selected.map((item) => item.uid)).toEqual(['1', '3']);
    expect(result.selected[0].reasons[0]).toMatchObject({ channel: 'semantic', similarity: 0.72 });
    expect(result.rejected).toEqual(expect.arrayContaining([
        expect.objectContaining({ uid: '2', decision: 'no-evidence' }),
        expect.objectContaining({ uid: '4', decision: 'semantic-only-limit' }),
    ]));
});

test('default similarity floor follows the measured lorebook boundary', () => {
    const result = rankLivingLore({
        packet: buildWorldSenseQueryPacket({ action: 'continue' }),
        entries: [entry(1, 'Vox-level match', []), entry(2, 'Noise-level match', [])],
        semanticMatches: [
            { book: 'Book', uid: '1', rank: 0, score: 0.338 },
            { book: 'Book', uid: '2', rank: 1, score: 0.288 },
        ],
    });
    expect(result.selected.map((item) => item.uid)).toEqual(['1']);
    expect(result.rejected).toEqual(expect.arrayContaining([expect.objectContaining({ uid: '2', decision: 'no-evidence' })]));
});

test('continuity boosts renewed evidence but cannot preserve stale noise alone', () => {
    const result = rankLivingLore({
        packet: buildWorldSenseQueryPacket({ action: 'Marissa returns' }),
        entries: [entry(1, 'Marissa', ['Marissa']), entry(2, 'Stale artifact', [])],
        continuity: [{ book: 'Book', uid: '1' }, { book: 'Book', uid: '2' }],
    });
    expect(result.selected[0].reasons.map((reason) => reason.channel)).toEqual(expect.arrayContaining(['action.primary', 'continuity']));
    expect(result.rejected).toEqual(expect.arrayContaining([expect.objectContaining({ uid: '2', decision: 'no-evidence' })]));
});

test('a thousand-entry candidate set stays inside prompt and latency budgets', () => {
    const entries = Array.from({ length: 1000 }, (_, index) => entry(index, `Entry ${index}`, [], 'x'.repeat(120)));
    const semanticMatches = entries.map((item, rank) => ({ book: item.book, uid: item.uid, rank, score: 0.9 - (rank / 10000) }));
    const startedAt = performance.now();
    const result = rankLivingLore({
        packet: buildWorldSenseQueryPacket({ action: 'continue the world' }), entries, semanticMatches,
        semanticThreshold: 0.3, semanticOnlyLimit: 1000, budget: { maxEntries: 12, maxTokens: 1800 },
    });
    const elapsedMs = performance.now() - startedAt;
    expect(result.selected.length).toBeLessThanOrEqual(12);
    expect(result.budget.usedTokens).toBeLessThanOrEqual(1800);
    expect(result.rejected.length).toBeGreaterThan(900);
    expect(elapsedMs).toBeLessThan(1000);
});
