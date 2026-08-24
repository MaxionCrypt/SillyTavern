import { beforeEach, expect, jest, test } from '@jest/globals';
import {
    applyLivingLoreProposals,
    invalidateLivingLoreProposals,
    listLivingLoreHistory,
    listLivingLoreProposals,
    queueLivingLoreProposals,
    rollbackLivingLoreTransaction,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-mutations.js';
import {
    getLivingLoreMetadata,
    upsertLivingLoreMetadata,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-store.js';
import { buildLivingLorePacket } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-proposals.js';
import { __setContextOverrides, __setExtensionSettings } from './util/st-context-stub.js';

const TIMELINE = 'timeline-marches';
const BOOK = 'The Marches';
let nativeBook;
let saves;

function entry(uid, overrides = {}) {
    return {
        uid, key: [`entry-${uid}`], keysecondary: [], comment: `Entry ${uid}`,
        content: 'Identity\nAn old truth.\n\nEstablished\n- The first fact.\n\nCurrent\nAt rest.',
        constant: false, disable: false, ...overrides,
    };
}

function packet(entries = [nativeBook.entries[42]]) {
    return buildLivingLorePacket({
        timelineId: TIMELINE,
        book: BOOK,
        bookHash: 'book-hash',
        entries: entries.map((item) => ({
            book: BOOK, uid: String(item.uid), name: item.comment, keys: item.key,
            secondaryKeys: item.keysecondary, content: item.content,
        })),
        selected: entries.map((item) => ({ book: BOOK, uid: String(item.uid), reasons: [{ channel: 'semantic' }] })),
        metadata: entries.map((item) => getLivingLoreMetadata(TIMELINE, { book: BOOK, uid: item.uid })),
    });
}

function proposal(operation, value, overrides = {}) {
    const sections = {
        'fact.append': 'Established', 'current.set': 'Current', 'thread.add': 'Open threads',
        'alias.add': 'Aliases', 'entry.link': 'Links', 'entry.retire': 'Retirement',
    };
    return {
        id: `proposal-${operation}`,
        operation,
        target: { book: BOOK, uid: '42', revision: 1 },
        entryType: 'entity', section: sections[operation], value,
        evidence: 'The bell rang twice.', confidence: 0.9, reason: 'The accepted scene established it.',
        ...overrides,
    };
}

beforeEach(() => {
    __setExtensionSettings({ remodel: {} });
    nativeBook = { entries: { 42: entry(42), 77: entry(77, { comment: 'Second entry' }) } };
    saves = [];
    __setContextOverrides({
        async loadWorldInfo(name) {
            expect(name).toBe(BOOK);
            return structuredClone(nativeBook);
        },
        async saveWorldInfo(name, data, immediately) {
            saves.push({ name, data: structuredClone(data), immediately });
            nativeBook = structuredClone(data);
        },
    });
    upsertLivingLoreMetadata(TIMELINE, { book: BOOK, uid: 42 }, { entryType: 'entity', revision: 1 });
    upsertLivingLoreMetadata(TIMELINE, { book: BOOK, uid: 77 }, { entryType: 'entity', revision: 1 });
});

test('Suggest mode queues a field-level diff without writing native lore', async () => {
    const proposed = proposal('current.set', 'Awake beneath the hill.');
    const result = await queueLivingLoreProposals({
        timelineId: TIMELINE, packet: packet(), proposals: [proposed],
        acceptedProse: 'The bell rang twice. Something answered below.',
    });

    expect(result.ok).toBe(true);
    expect(result.queued).toHaveLength(1);
    expect(result.queued[0]).toMatchObject({ status: 'suggested', mode: 'suggest', proposal: proposed });
    expect(result.queued[0].diff).toEqual([expect.objectContaining({
        field: 'content.Current', before: 'At rest.', after: 'Awake beneath the hill.',
    })]);
    expect(listLivingLoreProposals({ timelineId: TIMELINE, status: 'suggested' })).toHaveLength(1);
    expect(nativeBook.entries[42].content).toContain('At rest.');
    expect(saves).toHaveLength(0);
});

test('queue validation rejects unsupported evidence, protected fields, and oversized values', async () => {
    upsertLivingLoreMetadata(TIMELINE, { book: BOOK, uid: 42 }, { protectedFields: ['current'] });
    const proposals = [
        proposal('current.set', 'Unsupported change.', { id: 'bad-evidence', evidence: 'Never happened.' }),
        proposal('current.set', 'Protected change.', { id: 'protected' }),
        proposal('fact.append', 'x'.repeat(6001), { id: 'oversized' }),
    ];
    const result = await queueLivingLoreProposals({
        timelineId: TIMELINE, packet: packet(), proposals,
        acceptedProse: 'The bell rang twice.',
    });

    expect(result.queued).toEqual([]);
    expect(result.rejected.map((item) => item.code)).toEqual(['unsupported-evidence', 'protected-field', 'value-too-large']);
    expect(saves).toHaveLength(0);
});

test('applies several suggestions with one native save and one rollback audit', async () => {
    const proposals = [
        proposal('fact.append', 'The buried bell answers its own echo.', { id: 'fact' }),
        proposal('current.set', 'Awake beneath the hill.', { id: 'current' }),
        proposal('alias.add', 'Bell-Warden', { id: 'alias' }),
    ];
    const queued = await queueLivingLoreProposals({
        timelineId: TIMELINE, packet: packet(), proposals,
        acceptedProse: 'The bell rang twice.',
    });
    const applied = await applyLivingLoreProposals({
        timelineId: TIMELINE,
        proposalIds: queued.queued.map((item) => item.id),
    });

    expect(applied.ok).toBe(true);
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ name: BOOK, immediately: true });
    expect(nativeBook.entries[42].content).toContain('- The buried bell answers its own echo.');
    expect(nativeBook.entries[42].content).toContain('Current\nAwake beneath the hill.');
    expect(nativeBook.entries[42].key).toContain('Bell-Warden');
    expect(getLivingLoreMetadata(TIMELINE, { book: BOOK, uid: 42 }).revision).toBe(2);
    expect(listLivingLoreProposals({ timelineId: TIMELINE, status: 'applied' })).toHaveLength(3);
    expect(listLivingLoreHistory({ timelineId: TIMELINE })).toEqual([
        expect.objectContaining({ id: applied.transactionId, status: 'applied', proposalIds: expect.arrayContaining(['fact', 'current', 'alias']) }),
    ]);
});

test('a duplicate fact aborts the whole transaction before save', async () => {
    const proposals = [
        proposal('current.set', 'Awake beneath the hill.', { id: 'valid-first' }),
        proposal('fact.append', 'A newly witnessed fact.', { id: 'fact-first' }),
        proposal('fact.append', 'a newly witnessed fact', { id: 'duplicate-second' }),
    ];
    const queued = await queueLivingLoreProposals({
        timelineId: TIMELINE, packet: packet(), proposals,
        acceptedProse: 'The bell rang twice.',
    });
    const result = await applyLivingLoreProposals({
        timelineId: TIMELINE, proposalIds: queued.queued.map((item) => item.id),
    });

    expect(result).toMatchObject({ ok: false, code: 'duplicate-fact' });
    expect(nativeBook.entries[42].content).toContain('Current\nAt rest.');
    expect(saves).toHaveLength(0);
    expect(listLivingLoreProposals({ timelineId: TIMELINE, status: 'suggested' })).toHaveLength(3);
});

test('rollback restores native entry fields and metadata revisions atomically', async () => {
    const queued = await queueLivingLoreProposals({
        timelineId: TIMELINE, packet: packet(),
        proposals: [proposal('current.set', 'Awake beneath the hill.', { id: 'reversible' })],
        acceptedProse: 'The bell rang twice.',
    });
    const applied = await applyLivingLoreProposals({ timelineId: TIMELINE, proposalIds: [queued.queued[0].id] });
    const rolledBack = await rollbackLivingLoreTransaction({ timelineId: TIMELINE, transactionId: applied.transactionId });

    expect(rolledBack.ok).toBe(true);
    expect(saves).toHaveLength(2);
    expect(nativeBook.entries[42].content).toContain('Current\nAt rest.');
    expect(getLivingLoreMetadata(TIMELINE, { book: BOOK, uid: 42 }).revision).toBe(1);
    expect(listLivingLoreHistory({ timelineId: TIMELINE })[0].status).toBe('rolled-back');
});

test('a native save failure leaves suggestions and sidecar state untouched', async () => {
    const queued = await queueLivingLoreProposals({
        timelineId: TIMELINE, packet: packet(),
        proposals: [proposal('current.set', 'Awake beneath the hill.', { id: 'save-failure' })],
        acceptedProse: 'The bell rang twice.',
    });
    const save = jest.fn(async () => { throw new Error('backend refused save'); });
    __setContextOverrides({
        async loadWorldInfo() { return structuredClone(nativeBook); },
        saveWorldInfo: save,
    });
    const result = await applyLivingLoreProposals({ timelineId: TIMELINE, proposalIds: [queued.queued[0].id] });

    expect(result).toMatchObject({ ok: false, code: 'save-failed' });
    expect(save).toHaveBeenCalledTimes(2); // attempted write, then best-effort native cache/backend restore
    expect(getLivingLoreMetadata(TIMELINE, { book: BOOK, uid: 42 }).revision).toBe(1);
    expect(listLivingLoreProposals({ timelineId: TIMELINE, status: 'suggested' })).toHaveLength(1);
    expect(listLivingLoreHistory({ timelineId: TIMELINE })).toEqual([]);
});

test('links selected entries through metadata and retires without deleting native lore', async () => {
    const linkedPacket = packet([nativeBook.entries[42], nativeBook.entries[77]]);
    const proposals = [
        proposal('entry.link', {
            target: { book: BOOK, uid: '77', revision: 1 }, relation: 'Guards',
        }, { id: 'link', target: { book: BOOK, uid: '42', revision: 1 } }),
        proposal('entry.retire', undefined, { id: 'retire', reason: 'The fiction permanently superseded it.' }),
    ];
    const queued = await queueLivingLoreProposals({
        timelineId: TIMELINE, packet: linkedPacket, proposals,
        acceptedProse: 'The bell rang twice.',
    });
    const applied = await applyLivingLoreProposals({ timelineId: TIMELINE, proposalIds: queued.queued.map((item) => item.id) });

    expect(applied.ok).toBe(true);
    expect(Object.keys(nativeBook.entries)).toContain('42');
    expect(nativeBook.entries[42].disable).toBe(true);
    expect(nativeBook.entries[42].content).toContain('Retirement\nThe fiction permanently superseded it.');
    expect(getLivingLoreMetadata(TIMELINE, { book: BOOK, uid: 42 }).links).toEqual([
        { target: { book: BOOK, uid: '77' }, relation: 'guards' },
    ]);
});

test('entry.create allocates a new native uid and a revisioned Loom sidecar', async () => {
    const created = {
        id: 'create', operation: 'entry.create', target: { book: BOOK },
        entryType: 'history', section: 'Established',
        value: 'The buried bell answered itself beneath the hill.',
        evidence: 'The bell rang twice.', confidence: 0.95, reason: 'A durable event entered canon.',
    };
    const queued = await queueLivingLoreProposals({
        timelineId: TIMELINE, packet: packet(), proposals: [created], acceptedProse: 'The bell rang twice.',
    });
    const applied = await applyLivingLoreProposals({ timelineId: TIMELINE, proposalIds: [queued.queued[0].id] });

    expect(applied.ok).toBe(true);
    const newEntry = Object.values(nativeBook.entries).find((item) => ![42, 77].includes(item.uid));
    expect(newEntry).toMatchObject({ disable: false, content: 'Established\nThe buried bell answered itself beneath the hill.' });
    expect(getLivingLoreMetadata(TIMELINE, { book: BOOK, uid: newEntry.uid })).toMatchObject({
        entryType: 'history', origin: 'loom', revision: 1,
    });
});

test('a revision changed after queueing makes the complete apply transaction stale', async () => {
    const queued = await queueLivingLoreProposals({
        timelineId: TIMELINE, packet: packet(),
        proposals: [proposal('current.set', 'Awake beneath the hill.', { id: 'becomes-stale' })],
        acceptedProse: 'The bell rang twice.',
    });
    upsertLivingLoreMetadata(TIMELINE, { book: BOOK, uid: 42 }, {}, { incrementRevision: true });
    const result = await applyLivingLoreProposals({ timelineId: TIMELINE, proposalIds: [queued.queued[0].id] });

    expect(result).toMatchObject({ ok: false, code: 'stale-revision', proposalId: 'becomes-stale' });
    expect(saves).toHaveLength(0);
    expect(nativeBook.entries[42].content).toContain('Current\nAt rest.');
});

test('recovery is idempotent by direction and proposal identity', async () => {
    const input = {
        timelineId: TIMELINE, packet: packet(),
        proposals: [proposal('current.set', 'Awake beneath the hill.', { id: 'stable-proposal' })],
        acceptedProse: 'The bell rang twice.',
        source: { directionId: 'direction-1', messageId: 7, phase: 'complete' },
    };
    const first = await queueLivingLoreProposals(input);
    const recovered = await queueLivingLoreProposals(input);

    expect(first.queued[0].id).toBe(recovered.queued[0].id);
    expect(listLivingLoreProposals({ timelineId: TIMELINE })).toHaveLength(1);

    await applyLivingLoreProposals({ timelineId: TIMELINE, proposalIds: [first.queued[0].id] });
    const recoveredAfterApply = await queueLivingLoreProposals(input);
    expect(recoveredAfterApply).toMatchObject({ ok: true, rejected: [], queued: [{ id: first.queued[0].id, status: 'applied' }] });
    expect(listLivingLoreProposals({ timelineId: TIMELINE })).toHaveLength(1);
});

test('a superseded suggestion invalidates without touching applied history', async () => {
    const first = await queueLivingLoreProposals({
        timelineId: TIMELINE, packet: packet(),
        proposals: [proposal('current.set', 'First take.', { id: 'first-take' })],
        acceptedProse: 'The bell rang twice.',
        source: { directionId: 'direction-old', messageId: 7 },
    });
    const second = await queueLivingLoreProposals({
        timelineId: TIMELINE, packet: packet(),
        proposals: [proposal('current.set', 'Second take.', { id: 'second-take' })],
        acceptedProse: 'The bell rang twice.',
        source: { directionId: 'direction-kept', messageId: 7 },
    });
    await applyLivingLoreProposals({ timelineId: TIMELINE, proposalIds: [second.queued[0].id] });

    const result = invalidateLivingLoreProposals({ timelineId: TIMELINE, directionIds: ['direction-old', 'direction-kept'], reason: 'swipe' });
    expect(result.invalidated).toEqual([first.queued[0].id]);
    expect(listLivingLoreProposals({ timelineId: TIMELINE, status: 'invalidated' })).toHaveLength(1);
    expect(listLivingLoreProposals({ timelineId: TIMELINE, status: 'applied' })).toHaveLength(1);
});
