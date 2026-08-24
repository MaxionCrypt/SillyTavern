import { jest } from '@jest/globals';
import {
    hashText,
    invalidateTimelineLoreCache,
    loadTimelineLore,
    normalizeTimelineLoreEntry,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/world-sense-lore.js';
import { __emit, __setContextOverrides, __setExtensionSettings } from './util/st-context-stub.js';

const TIMELINE = 'timeline-world-sense';

function installTimeline(lorebookName = 'Living Marches') {
    __setExtensionSettings({ remodel: { timelineV1: {
        version: 1,
        timelineIds: [TIMELINE],
        timelines: { [TIMELINE]: { id: TIMELINE, lorebookName, arcIds: [], activeArcId: null, activeSceneId: null } },
        arcs: {}, scenes: {}, activeTimelineId: TIMELINE,
    } } });
}

beforeEach(() => {
    invalidateTimelineLoreCache();
    installTimeline();
});

test('returns only the Timeline-bound lorebook as detached normalized entries', async () => {
    const native = { entries: {
        12: { uid: 12, comment: 'Old Harbor', key: ['harbor'], keysecondary: ['shipping'], content: 'A tidal port.', disable: false, constant: true },
        3: { uid: 3, key: ['Marches'], content: 'A contested frontier.', selective: false },
    } };
    const before = structuredClone(native);
    __setContextOverrides({
        getWorldInfoNames: () => ['Living Marches', 'Global Book'],
        loadWorldInfo: jest.fn(async (book) => book === 'Living Marches' ? native : { entries: { 99: { uid: 99 } } }),
    });

    const packet = await loadTimelineLore(TIMELINE);
    expect(packet.book).toBe('Living Marches');
    expect(packet.entries.map((entry) => entry.uid)).toEqual(['3', '12']);
    expect(packet.entries[1]).toMatchObject({ name: 'Old Harbor', keys: ['harbor'], secondaryKeys: ['shipping'], content: 'A tidal port.' });
    expect(packet.entries[1].native).toMatchObject({ disable: false, constant: true });
    packet.entries[1].content = 'consumer mutation';
    expect(native).toEqual(before);
});

test('returns an empty packet when the Timeline has no assigned book', async () => {
    installTimeline(null);
    __setContextOverrides({ loadWorldInfo: jest.fn() });
    const packet = await loadTimelineLore(TIMELINE);
    expect(packet).toMatchObject({ timelineId: TIMELINE, book: null, entries: [] });
});

test('caches loads until a native World Info event invalidates the book', async () => {
    const loadWorldInfo = jest.fn(async () => ({ entries: { 1: { uid: 1, key: ['one'], content: 'First' } } }));
    __setContextOverrides({ loadWorldInfo });
    await loadTimelineLore(TIMELINE);
    await loadTimelineLore(TIMELINE);
    expect(loadWorldInfo).toHaveBeenCalledTimes(1);

    await __emit('WORLDINFO_UPDATED', 'Living Marches');
    await loadTimelineLore(TIMELINE);
    expect(loadWorldInfo).toHaveBeenCalledTimes(2);
});

test('entry and book fingerprints change with meaningful native edits', () => {
    const first = normalizeTimelineLoreEntry('Book', { uid: 1, key: ['alias'], content: 'First', probability: 100 });
    const second = normalizeTimelineLoreEntry('Book', { uid: 1, key: ['alias'], content: 'Second', probability: 100 });
    expect(first.hash).not.toBe(second.hash);
    expect(hashText('same')).toBe(hashText('same'));
});
