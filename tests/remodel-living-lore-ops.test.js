import { __setExtensionSettings, __setContextOverrides } from './util/st-context-stub.js';
import { createTimeline, updateTimeline, createArc, createScene } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/timeline-state.js';
import { addEntryRefs, listSceneEntryRefs } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-cache-store.js';
import { applyLoreOps } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-ops.js';

function seed({ lorebookName = 'TL' } = {}) {
    __setExtensionSettings({ remodel: {} });
    const tl = createTimeline('T');
    if (lorebookName) updateTimeline(tl.id, { lorebookName });
    const arc = createArc(tl.id, 'A');
    const scene = createScene(arc.id, 'roleplay', 'S');
    return { timelineId: tl.id, sceneId: scene.id };
}

// In-memory native World Info book behind loadWorldInfo/saveWorldInfo.
function withBook(entries) {
    const books = { TL: { entries: { ...entries } } };
    __setContextOverrides({
        async loadWorldInfo(name) { return books[name] || null; },
        async saveWorldInfo(name, data) { books[name] = data; },
    });
    return books;
}

test('lore.edit rewrites content of a cached entry', async () => {
    const { sceneId, timelineId } = seed();
    const books = withBook({ 1: { uid: 1, key: ['Rayse'], keysecondary: [], content: 'old' } });
    addEntryRefs(sceneId, [{ book: 'TL', uid: '1' }]);
    const r = await applyLoreOps({ sceneId, timelineId, ops: [{ op: 'lore.edit', book: 'TL', uid: '1', content: 'new content' }] });
    expect(r.applied).toEqual([{ op: 'lore.edit', book: 'TL', uid: '1' }]);
    expect(books.TL.entries[1].content).toBe('new content');
});

test('lore.edit on an entry NOT in the cache is refused, not written', async () => {
    const { sceneId, timelineId } = seed();
    const books = withBook({ 1: { uid: 1, key: ['Rayse'], keysecondary: [], content: 'old' } });
    const r = await applyLoreOps({ sceneId, timelineId, ops: [{ op: 'lore.edit', book: 'TL', uid: '1', content: 'x' }] });
    expect(r.applied).toEqual([]);
    expect(r.refused[0]).toMatchObject({ op: 'lore.edit', reason: 'not-in-cache' });
    expect(books.TL.entries[1].content).toBe('old');
});

test('lore.create adds a new entry to the timeline book and the cache', async () => {
    const { sceneId, timelineId } = seed({ lorebookName: 'TL' });
    const books = withBook({});
    const r = await applyLoreOps({ sceneId, timelineId, ops: [{ op: 'lore.create', name: 'Silvia', keys: ['Silvia'], content: 'a mage' }] });
    expect(r.applied[0]).toMatchObject({ op: 'lore.create', book: 'TL' });
    const uid = r.applied[0].uid;
    expect(books.TL.entries[uid]).toMatchObject({ comment: 'Silvia', key: ['Silvia'], content: 'a mage' });
    expect(listSceneEntryRefs(sceneId)).toContainEqual({ book: 'TL', uid: String(uid) });
});

test('lore.create is refused when the timeline has no bound book', async () => {
    const { sceneId, timelineId } = seed({ lorebookName: '' });
    withBook({});
    const r = await applyLoreOps({ sceneId, timelineId, ops: [{ op: 'lore.create', name: 'X', keys: ['X'], content: 'y' }] });
    expect(r.applied).toEqual([]);
    expect(r.refused[0]).toMatchObject({ op: 'lore.create', reason: 'no-timeline-book' });
});

test('lore.edit secret:true hides an entry (reserved keyword + disabled)', async () => {
    const { sceneId, timelineId } = seed();
    const books = withBook({ 1: { uid: 1, key: ['Rayse'], keysecondary: [], content: 'old', disable: false } });
    addEntryRefs(sceneId, [{ book: 'TL', uid: '1' }]);
    await applyLoreOps({ sceneId, timelineId, ops: [{ op: 'lore.edit', book: 'TL', uid: '1', content: 'now hidden', secret: true }] });
    expect(books.TL.entries[1]).toMatchObject({ content: 'now hidden', key: ['Rayse', 'secret'], disable: true });
});

test('lore.edit secret:false reveals an entry (drops the keyword + enables)', async () => {
    const { sceneId, timelineId } = seed();
    const books = withBook({ 1: { uid: 1, key: ['Rayse', 'secret'], keysecondary: [], content: 'hidden', disable: true } });
    addEntryRefs(sceneId, [{ book: 'TL', uid: '1' }]);
    await applyLoreOps({ sceneId, timelineId, ops: [{ op: 'lore.edit', book: 'TL', uid: '1', content: 'now open', secret: false }] });
    expect(books.TL.entries[1]).toMatchObject({ content: 'now open', key: ['Rayse'], disable: false });
});

test('lore.edit with no secret flag leaves visibility untouched', async () => {
    const { sceneId, timelineId } = seed();
    const books = withBook({ 1: { uid: 1, key: ['Rayse', 'secret'], keysecondary: [], content: 'hidden', disable: true } });
    addEntryRefs(sceneId, [{ book: 'TL', uid: '1' }]);
    await applyLoreOps({ sceneId, timelineId, ops: [{ op: 'lore.edit', book: 'TL', uid: '1', content: 'still hidden' }] });
    expect(books.TL.entries[1]).toMatchObject({ content: 'still hidden', key: ['Rayse', 'secret'], disable: true });
});

test('lore.create secret:true makes a hidden entry that is still cached for the Loom', async () => {
    const { sceneId, timelineId } = seed({ lorebookName: 'TL' });
    const books = withBook({});
    const r = await applyLoreOps({ sceneId, timelineId, ops: [{ op: 'lore.create', name: 'The Pact', keys: ['Pact'], content: 'buried', secret: true }] });
    const uid = r.applied[0].uid;
    expect(books.TL.entries[uid]).toMatchObject({ comment: 'The Pact', key: ['Pact', 'secret'], disable: true });
    expect(listSceneEntryRefs(sceneId)).toContainEqual({ book: 'TL', uid: String(uid) });
});
