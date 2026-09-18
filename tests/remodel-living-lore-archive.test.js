import { expect, test } from '@jest/globals';
import { __setContextOverrides, __setExtensionSettings } from './util/st-context-stub.js';
import { createArc, createScene, createTimeline } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/timeline-state.js';
import { addEntryRefs } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-cache-store.js';
import { filterLivingLoreEntries, groupLivingLoreEntries, listSceneLivingLoreEntries, listTimelineLivingLoreEntries, updateSceneLivingLoreEntry } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-archive.js';

test('Living Lore Archive finds titles and either kind of tag', () => {
    const entries = [
        { title: 'Mara Vellane', tags: ['Mara'], secondaryTags: ['church'] },
        { title: 'Glass Key', tags: ['artifact'], secondaryTags: [] },
    ];
    expect(filterLivingLoreEntries(entries, 'vell')).toEqual([entries[0]]);
    expect(filterLivingLoreEntries(entries, 'church')).toEqual([entries[0]]);
    expect(filterLivingLoreEntries(entries, 'artifact')).toEqual([entries[1]]);
});

test('Living Lore Archive groups connected entries once by shared tags and keeps lone entries separate', () => {
    const groups = groupLivingLoreEntries([
        { title: 'Mara', tags: ['Mara', 'church'], secondaryTags: [] },
        { title: 'Church Bell', tags: ['church', 'bell'], secondaryTags: [] },
        { title: 'Bell Tower', tags: ['bell'], secondaryTags: [] },
        { title: 'Glass Key', tags: ['artifact'], secondaryTags: [] },
    ]);
    expect(groups[0]).toMatchObject({ label: 'bell · church', entries: [{ title: 'Bell Tower' }, { title: 'Church Bell' }, { title: 'Mara' }] });
    expect(groups[1]).toMatchObject({ label: 'Other active lore', entries: [{ title: 'Glass Key' }] });
    expect(groups.flatMap((group) => group.entries).map((entry) => entry.title)).toHaveLength(4);
});

test('Living Lore Archive re-reads only this Scene cached native refs', async () => {
    __setExtensionSettings({ remodel: {} });
    const timeline = createTimeline('T');
    const arc = createArc(timeline.id, 'A');
    const scene = createScene(arc.id, 'roleplay', 'S');
    addEntryRefs(scene.id, [{ book: 'T-book', uid: '4' }]);
    __setContextOverrides({
        async getWorldInfoEntriesForBook(book) {
            expect(book).toBe('T-book');
            return [
                { uid: 4, comment: 'Mara Vellane', key: ['Mara'], keysecondary: ['church'], content: 'At the church.' },
                { uid: 9, comment: 'Uncached', key: ['outside'], keysecondary: [], content: 'Not shown.' },
            ];
        },
    });

    await expect(listSceneLivingLoreEntries(scene.id)).resolves.toEqual([
        { book: 'T-book', uid: '4', title: 'Mara Vellane', tags: ['Mara'], secondaryTags: ['church'], content: 'At the church.', sceneIds: [scene.id] },
    ]);
});

test('Living Lore Archive is available from the Timeline and retains every Scene that activated a ref', async () => {
    __setExtensionSettings({ remodel: {} });
    const timeline = createTimeline('T');
    const arc = createArc(timeline.id, 'A');
    const first = createScene(arc.id, 'roleplay', 'First');
    const second = createScene(arc.id, 'story', 'Second');
    addEntryRefs(first.id, [{ book: 'T-book', uid: '4' }]);
    addEntryRefs(second.id, [{ book: 'T-book', uid: '4' }, { book: 'T-book', uid: '8' }]);
    __setContextOverrides({
        async getWorldInfoEntriesForBook() {
            return [
                { uid: 4, comment: 'Mara', key: ['Mara'], keysecondary: [], content: 'Present twice.' },
                { uid: 8, comment: 'Bell', key: ['bell'], keysecondary: [], content: 'Present once.' },
            ];
        },
    });

    await expect(listTimelineLivingLoreEntries(timeline.id)).resolves.toEqual([
        { book: 'T-book', uid: '8', title: 'Bell', tags: ['bell'], secondaryTags: [], content: 'Present once.', sceneIds: [second.id] },
        { book: 'T-book', uid: '4', title: 'Mara', tags: ['Mara'], secondaryTags: [], content: 'Present twice.', sceneIds: [first.id, second.id] },
    ]);
});

test('Living Lore Archive writes a title, tags, and content only to a cached native entry', async () => {
    __setExtensionSettings({ remodel: {} });
    const timeline = createTimeline('T');
    const arc = createArc(timeline.id, 'A');
    const scene = createScene(arc.id, 'roleplay', 'S');
    addEntryRefs(scene.id, [{ book: 'T-book', uid: '7' }]);
    const books = { 'T-book': { entries: { 7: { uid: 7, comment: 'Old', key: ['old'], keysecondary: [], content: 'before' } } } };
    __setContextOverrides({
        async loadWorldInfo(book) { return books[book]; },
        async saveWorldInfo(book, data) { books[book] = data; },
    });

    const saved = await updateSceneLivingLoreEntry({ sceneId: scene.id, book: 'T-book', uid: '7', title: 'Mara', tags: 'Mara, priestess', secondaryTags: 'church', content: 'after' });
    expect(saved).toMatchObject({ ok: true, entry: { title: 'Mara', tags: ['Mara', 'priestess'], secondaryTags: ['church'], content: 'after' } });
    expect(books['T-book'].entries[7]).toMatchObject({ comment: 'Mara', key: ['Mara', 'priestess'], keysecondary: ['church'], content: 'after' });
});
