import { jest } from '@jest/globals';
import { createArchiveSettlementEvent } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/archive-consequences.js';
import { createTimelineLoreProjector } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/timeline-lore-projection.js';
import { __setExtensionSettings } from './util/st-context-stub.js';

beforeEach(() => {
    __setExtensionSettings({ remodel: {} });
});

function event(overrides = {}) {
    return createArchiveSettlementEvent({
        jobId: 'archive:lore-1', timelineId: 'timeline-lore-1', sceneId: 'scene-lore-1', mode: 'roleplay',
        provenance: { sourceId: 'turn-lore-1', messageId: 11, checkpointId: 'accepted' },
        routeSnapshot: { role: 'loom', profileId: 'loom-profile-1', profileName: 'Loom One' }, recipeId: 'recipe-1',
        acceptedProse: 'Mara took permanent command of the North Gate watch.',
        operations: [{ id: 'a1', capability: 'event.record', arguments: { summary: 'Mara took command.' }, reason: 'accepted prose' }],
        archiveFacts: ['Mara took permanent command of the North Gate watch.'], transactionId: 'archive-tx-1',
        ...overrides,
    }, () => 100);
}

function packet() {
    return {
        protocol: 'living-lore.loom-packet.v1', timelineId: 'timeline-lore-1', book: 'North Book', bookHash: 'book-hash',
        entries: [{
            target: { book: 'North Book', uid: '7', revision: 2 }, name: 'Mara', entryType: 'entity',
            protectedFields: [], keys: ['Mara'], secondaryKeys: [], content: 'Mara commands a patrol.', selectedBecause: ['semantic'],
        }],
        bounds: { maxEntries: 12, maxEntryChars: 6000, maxChars: 24000, usedEntries: 1, usedChars: 24 },
        promotion: { protocol: 'world-sense.promotion-candidates.v1', candidates: [] },
    };
}

function fence(proposals = []) {
    return `\`\`\`state\n${JSON.stringify({ requests: [], loreProposals: proposals, lorePromotionDecisions: [] })}\n\`\`\``;
}

test('Archive settlement queues lore work without putting retrieval on the Archive critical path', async () => {
    const scheduled = [];
    const resolve = jest.fn(async () => ({ loomPacket: packet(), receipt: { id: 'ws-1' }, degraded: false }));
    const projector = createTimelineLoreProjector({
        resolve, schedule: (task) => scheduled.push(task), profile: () => ({ mode: 'suggest' }),
        transport: async () => fence(), queue: async () => ({ ok: true, queued: [], rejected: [] }),
    });
    const queued = projector.enqueue(event());
    expect(queued).toMatchObject({ status: 'queued', eventId: 'archive-settlement:archive:lore-1' });
    expect(resolve).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);

    scheduled[0]();
    const settled = await projector.wait('archive-settlement:archive:lore-1');
    expect(settled).toMatchObject({ status: 'succeeded', result: { status: 'succeeded', worldSenseReceiptId: 'ws-1' } });
});

test('accepted Archive evidence produces a detached review-only Living Lore proposal', async () => {
    const proposal = {
        id: 'l1', operation: 'fact.append', target: { book: 'North Book', uid: '7', revision: 2 },
        entryType: 'entity', section: 'Established', value: 'Mara permanently commands the North Gate watch.',
        evidence: 'Mara took permanent command of the North Gate watch.', confidence: 0.96,
        reason: 'The accepted fiction establishes a durable command role.',
    };
    const queue = jest.fn(async ({ proposals }) => ({ ok: true, queued: proposals.map((item) => ({ id: item.id })), rejected: [] }));
    const transport = jest.fn(async ({ routeSnapshot }) => {
        expect(routeSnapshot.profileId).toBe('loom-profile-1');
        return fence([proposal]);
    });
    const result = await createTimelineLoreProjector({
        resolve: async () => ({ loomPacket: packet(), receipt: { id: 'ws-2' }, degraded: false }),
        transport, queue, profile: () => ({ mode: 'auto-safe' }),
    }).project(event());
    expect(result).toMatchObject({ status: 'succeeded', proposed: 1, queued: ['l1'], automation: 'review-only' });
    expect(queue).toHaveBeenCalledWith(expect.objectContaining({
        acceptedProse: 'Mara took permanent command of the North Gate watch.',
        archiveFacts: ['Mara took permanent command of the North Gate watch.'],
        automationModeOverride: 'suggest',
        source: expect.objectContaining({ authority: 'accepted-fiction', archiveTransactionId: 'archive-tx-1' }),
    }));
});

test('Story Archive settlements use the same detached lore projection boundary', async () => {
    const resolve = jest.fn(async (scene) => {
        expect(scene).toMatchObject({ mode: 'story', timelineId: 'timeline-lore-1', id: 'scene-lore-1' });
        return { loomPacket: packet(), receipt: { id: 'ws-story' }, degraded: false };
    });
    const result = await createTimelineLoreProjector({
        resolve,
        transport: async () => fence(),
        queue: async () => ({ ok: true, queued: [], rejected: [] }),
        profile: () => ({ mode: 'suggest' }),
    }).project(event({ mode: 'story' }));
    expect(result).toMatchObject({ status: 'succeeded', worldSenseReceiptId: 'ws-story' });
    expect(resolve).toHaveBeenCalledTimes(1);
});

test('typed lore links use the same review queue rather than a separate mutation path', async () => {
    const lorePacket = packet();
    lorePacket.entries.push({
        target: { book: 'North Book', uid: '9', revision: 1 }, name: 'North Gate', entryType: 'location',
        protectedFields: [], keys: ['North Gate'], secondaryKeys: [], content: 'A fortified gate.', selectedBecause: ['direct'],
    });
    const link = {
        id: 'link-1', operation: 'entry.link', target: { book: 'North Book', uid: '7', revision: 2 },
        entryType: 'entity', section: 'Links',
        value: { target: { book: 'North Book', uid: '9', revision: 1 }, relation: 'commands watch at' },
        evidence: 'Mara took permanent command of the North Gate watch.', confidence: 0.94, reason: 'Durable relationship.',
    };
    const queue = jest.fn(async ({ proposals }) => ({ ok: true, queued: proposals.map((item) => ({ id: item.id })), rejected: [] }));
    const result = await createTimelineLoreProjector({
        resolve: async () => ({ loomPacket: lorePacket, receipt: { id: 'ws-3' } }),
        transport: async () => fence([link]), queue, profile: () => ({ mode: 'suggest' }),
    }).project(event());
    expect(result).toMatchObject({ status: 'succeeded', typedLinks: 1, queued: ['link-1'] });
});

test('World Sense failure degrades only the downstream projection', async () => {
    const transport = jest.fn();
    const result = await createTimelineLoreProjector({
        resolve: async () => { throw new Error('local index unavailable'); }, transport,
    }).project(event());
    expect(result).toMatchObject({ status: 'failed-open', degraded: true, error: 'local index unavailable' });
    expect(transport).not.toHaveBeenCalled();
    expect(result).toMatchObject({ eventId: 'archive-settlement:archive:lore-1' });
});

test('an unusable lore response fails only its detached job and never the committed Archive event', async () => {
    const scheduled = [];
    const projector = createTimelineLoreProjector({
        resolve: async () => ({ loomPacket: packet(), receipt: { id: 'ws-bad' } }),
        transport: async () => 'I would update Mara later.',
        queue: jest.fn(), profile: () => ({ mode: 'suggest' }), schedule: (task) => scheduled.push(task),
    });
    const archiveEvent = event();
    expect(projector.enqueue(archiveEvent).status).toBe('queued');
    scheduled[0]();
    const settled = await projector.wait(archiveEvent.eventId);
    expect(settled).toMatchObject({ status: 'failed', error: 'Living Lore projection returned no readable state fence.' });
    expect(archiveEvent.baseArchive).toEqual({ status: 'applied', transactionId: 'archive-tx-1' });
});

test('observe mode records retrieval but never spends a Loom request or queues a proposal', async () => {
    const transport = jest.fn();
    const queue = jest.fn();
    const result = await createTimelineLoreProjector({
        resolve: async () => ({ loomPacket: packet(), receipt: { id: 'ws-observe' }, degraded: false }),
        transport, queue, profile: () => ({ mode: 'observe' }),
    }).project(event());
    expect(result).toMatchObject({ status: 'no-op', worldSenseReceiptId: 'ws-observe' });
    expect(transport).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
});

test('duplicate settlement delivery schedules exactly one lore projection', () => {
    const scheduled = [];
    const projector = createTimelineLoreProjector({ schedule: (task) => scheduled.push(task) });
    const first = projector.enqueue(event());
    const second = projector.enqueue(event());
    expect(second.jobId).toBe(first.jobId);
    expect(scheduled).toHaveLength(1);
});
