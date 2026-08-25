import { projectArchiveEvents, renderArchiveProjection } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/archive-projection.js';

function events(count) {
    return Array.from({ length: count }, (_, seq) => ({ id: `evt-${seq}`, seq, summary: `Routine event ${seq} happened in the market.` }));
}

test('keeps newest events, retrieves relevant older continuity, and stays capped', () => {
    const ledger = events(40);
    ledger[3].summary = 'Mara hid the obsidian key beneath the chapel floor.';
    const projection = projectArchiveEvents(ledger, { query: 'Mara searches for the obsidian key', maxEntries: 14 });

    expect(projection.entries).toHaveLength(14);
    expect(projection.receipt.recentIds).toEqual(events(40).slice(-10).map((event) => event.id));
    expect(projection.receipt.retrievedIds).toContain('evt-3');
    expect(projection.entries.some((entry) => entry.id === 'evt-3')).toBe(true);
});

test('deduplicates only the prompt projection and links summaries to raw evidence', () => {
    const ledger = events(35);
    ledger[4].summary = ledger[2].summary;
    const before = structuredClone(ledger);
    const projection = projectArchiveEvents(ledger, { maxEntries: 12 });
    const summaries = projection.entries.filter((entry) => entry.kind === 'summary');

    expect(ledger).toEqual(before);
    expect(projection.receipt.storedCount).toBe(35);
    expect(projection.receipt.duplicateIds).toContain('evt-2');
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries.every((entry) => entry.sourceEventIds.length > 0)).toBe(true);
    expect(projection.receipt.summarizedEventIds).toEqual(expect.arrayContaining(summaries.flatMap((entry) => entry.sourceEventIds)));
    expect(renderArchiveProjection(projection)).toContain('Earlier (events');
});

test('a small macro budget means newest projected events, not an unbounded archive', () => {
    const projection = projectArchiveEvents(events(8), { query: 'event', maxEntries: 2 });
    expect(projection.entries.map((entry) => entry.id)).toEqual(['evt-6', 'evt-7']);
    expect(projection.receipt.projectedCount).toBe(2);
});

test('short character names remain valid retrieval evidence', () => {
    const ledger = events(20);
    ledger[1].summary = 'Eli entrusted Teo with the brass compass.';
    const projection = projectArchiveEvents(ledger, { query: 'Teo asks Eli about the compass', maxEntries: 12 });
    expect(projection.receipt.retrievedIds).toContain('evt-1');
});

test('zero budget omits Archive event material without touching raw events', () => {
    const ledger = events(3);
    const projection = projectArchiveEvents(ledger, { maxEntries: 0 });
    expect(projection.entries).toEqual([]);
    expect(ledger).toHaveLength(3);
});

test('recalled continuity shares the Archive budget and renders its provenance', () => {
    const projection = projectArchiveEvents(events(8), {
        maxEntries: 4,
        continuity: [{
            kind: 'continuity', recordId: 'evt-old', recordType: 'event', text: 'Mara hid the obsidian key.',
            sceneId: 'scene-old', sceneTitle: 'The Cellar', arcId: 'arc-old', arcTitle: 'Arrival', score: 70,
        }],
    });

    expect(projection.entries).toHaveLength(4);
    expect(projection.entries[0]).toMatchObject({ kind: 'recall', sourceLabel: 'Arrival · The Cellar' });
    expect(projection.receipt.recalledCount).toBe(1);
    expect(renderArchiveProjection(projection)).toContain('Recalled from Arrival · The Cellar');
});
