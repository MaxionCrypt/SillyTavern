import {
    loreEntryKey,
    normalizeGoalLoreLink,
    normalizeLivingLoreMetadata,
    sameLoreEntry,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-model.js';
import {
    getLivingLoreMetadata,
    getLivingLoreStore,
    listLivingLoreMetadata,
    removeLivingLoreMetadata,
    restoreLivingLoreStore,
    snapshotLivingLoreStore,
    upsertLivingLoreMetadata,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-store.js';
import { __getExtensionSettings, __setExtensionSettings } from './util/st-context-stub.js';

const TIMELINE = 'timeline-living-lore';
const REF = { book: 'The Marches', uid: 42 };

beforeEach(() => {
    __setExtensionSettings({ remodel: {} });
});

describe('Living Lore pure contracts', () => {
    test('uses the same book plus uid identity for Remodel and native World Info shapes', () => {
        expect(loreEntryKey(REF)).toBe('The Marches.42');
        expect(loreEntryKey({ world: 'The Marches', uid: '42' })).toBe('The Marches.42');
        expect(sameLoreEntry(REF, { world: 'The Marches', uid: '42' })).toBe(true);
        expect(loreEntryKey({ book: '', uid: 42 })).toBe('');
    });

    test('normalizes metadata without mutating its input', () => {
        const input = {
            book: 'The Marches', uid: 42, type: 'seed', revision: 0, origin: 'loom',
            protected: ['identity', 'identity', 'not-a-field'],
            links: [
                { target: { book: 'The Marches', uid: 8 }, relation: 'Member Of' },
                { target: { world: 'The Marches', uid: '8' }, relation: 'member of' },
            ],
        };
        const before = structuredClone(input);
        const result = normalizeLivingLoreMetadata(input);

        expect(result).toMatchObject({
            book: 'The Marches', uid: '42', entryType: 'seed', revision: 1, origin: 'loom',
            protectedFields: ['identity'],
        });
        expect(result.links).toEqual([{ target: { book: 'The Marches', uid: '8' }, relation: 'member-of' }]);
        expect(input).toEqual(before);
    });

    test('accepts only the decided Goal-to-lore link types', () => {
        expect(normalizeGoalLoreLink({ ...REF, type: 'STAKE' })).toEqual({ book: 'The Marches', uid: '42', type: 'stake' });
        expect(normalizeGoalLoreLink({ ...REF, type: 'owner' })).toBeNull();
    });
});

describe('Living Lore metadata store', () => {
    test('creates an extension-owned versioned store', () => {
        expect(getLivingLoreStore()).toEqual({ version: 1, timelines: {} });
        expect(__getExtensionSettings().remodel.livingLoreV1.version).toBe(1);
    });

    test('upserts, filters, increments revisions explicitly, and removes metadata', () => {
        const created = upsertLivingLoreMetadata(TIMELINE, REF, { entryType: 'situation', origin: 'imported' });
        expect(created).toMatchObject({ ...REF, uid: '42', entryType: 'situation', revision: 1, origin: 'imported' });
        expect(getLivingLoreMetadata(TIMELINE, { world: 'The Marches', uid: 42 })).toEqual(created);
        expect(listLivingLoreMetadata({ timelineId: TIMELINE, book: 'The Marches' })).toHaveLength(1);
        expect(listLivingLoreMetadata({ timelineId: TIMELINE, book: 'Elsewhere' })).toHaveLength(0);

        const revised = upsertLivingLoreMetadata(TIMELINE, REF, { protectedFields: ['current'] }, { incrementRevision: true });
        expect(revised.revision).toBe(2);
        expect(revised.protectedFields).toEqual(['current']);
        expect(upsertLivingLoreMetadata(TIMELINE, REF, { revision: 1 }).revision).toBe(2);
        expect(removeLivingLoreMetadata(TIMELINE, REF)).toBe(true);
        expect(getLivingLoreMetadata(TIMELINE, REF)).toBeNull();
    });

    test('repairs an older or malformed sidecar without discarding valid records', () => {
        __setExtensionSettings({ remodel: { livingLoreV1: {
            version: 0,
            timelines: {
                [TIMELINE]: {
                    book: 'The Marches',
                    entries: {
                        staleKey: { book: 'The Marches', uid: 9, type: 'history', revision: 'bad', origin: 'migration' },
                        broken: 'not an entry',
                    },
                },
            },
        } } });

        const store = getLivingLoreStore();
        expect(store.version).toBe(1);
        expect(Object.keys(store.timelines[TIMELINE].entries)).toEqual(['The Marches.9']);
        expect(store.timelines[TIMELINE].entries['The Marches.9']).toMatchObject({ entryType: 'history', revision: 1 });
    });

    test('snapshots and restores independently cloned metadata', () => {
        upsertLivingLoreMetadata(TIMELINE, REF, { entryType: 'rule' });
        const snapshot = snapshotLivingLoreStore();
        upsertLivingLoreMetadata(TIMELINE, { book: 'The Marches', uid: 43 }, { entryType: 'entity' });

        const restored = restoreLivingLoreStore(snapshot);
        expect(Object.keys(restored.timelines[TIMELINE].entries)).toEqual(['The Marches.42']);
        expect(restored).not.toBe(snapshot);
    });

    test('cannot mutate native World Info while metadata changes', () => {
        const nativeWorldInfo = {
            entries: {
                42: { uid: 42, key: ['marches'], keysecondary: [], comment: 'The Marches', content: 'A contested frontier.', constant: false },
            },
        };
        const before = structuredClone(nativeWorldInfo);
        Object.freeze(nativeWorldInfo.entries[42]);
        Object.freeze(nativeWorldInfo.entries);
        Object.freeze(nativeWorldInfo);

        upsertLivingLoreMetadata(TIMELINE, REF, { entryType: 'situation', protectedFields: ['established'] });
        removeLivingLoreMetadata(TIMELINE, REF);

        expect(nativeWorldInfo).toEqual(before);
    });
});
