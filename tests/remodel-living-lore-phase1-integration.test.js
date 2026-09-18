import { test, expect, beforeEach, afterEach } from '@jest/globals';
import { initLiveDirection, setLiveDirectionTestAdapters, applyLoomLoreOps, applyLoomKeywordImport } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js';
import { __setExtensionSettings, __setContextOverrides } from './util/st-context-stub.js';
import { __setWorldInfoState } from './util/world-info-stub.js';
import { listSceneEntryRefs, getSceneLivingLore, addEntryRefs } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-cache-store.js';
import { buildSceneLivingLorePacket } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-cache-packet.js';
import { formatLivingLorePacket } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-proposals.js';

const scene = { id: 's1', timelineId: 't1' };
const rayse = { uid: 1, world: 'TL', key: ['Rayse'], keysecondary: [], selective: false, selectiveLogic: 0, content: 'Rayse is a knight.', comment: 'Rayse', disable: false };
const silvia = { uid: 2, world: 'TL', key: ['Silvia'], keysecondary: [], selective: false, selectiveLogic: 0, content: 'Silvia is a mage.', comment: 'Silvia', disable: false };

/** A commit-path run carrying just the Loom's keyword import for this Scene. */
function importRun(groups) {
    return { sceneId: scene.id, timelineId: scene.timelineId, directionId: 'd1', messageId: 0, envelope: { loreKeywords: groups } };
}

beforeEach(() => {
    __setExtensionSettings({});
    initLiveDirection({
        getActiveScene: () => scene, getCast: () => [], getPersona: () => null,
        ensureSceneReady: async () => true, getComposerDraft: () => '', clearComposer: () => {},
        sendNormally: () => {}, onStateChange: () => {}, onSettled: () => {}, onFailure: () => {},
        setNativePromptContent: () => {},
    });
    __setWorldInfoState({ selected_world_info: ['TL'] });
});
afterEach(() => setLiveDirectionTestAdapters(null));

test('a Loom keyword import populates the Scene Living Lore cache', async () => {
    __setContextOverrides({ async getWorldInfoEntriesForBook(name) { return name === 'TL' ? [rayse] : []; } });
    await applyLoomKeywordImport(importRun([['Rayse']]));
    expect(listSceneEntryRefs(scene.id)).toEqual([{ book: 'TL', uid: '1' }]);
    expect(getSceneLivingLore(scene.id, { create: false }).keywordGroups).toEqual([['Rayse']]);
});

test('a new non-empty import replaces the previous working set (wipe + rebuild)', async () => {
    __setContextOverrides({ async getWorldInfoEntriesForBook(name) { return name === 'TL' ? [rayse, silvia] : []; } });
    await applyLoomKeywordImport(importRun([['Rayse']]));
    expect(listSceneEntryRefs(scene.id)).toEqual([{ book: 'TL', uid: '1' }]);
    await applyLoomKeywordImport(importRun([['Silvia']]));         // wipes Rayse, pulls Silvia
    expect(listSceneEntryRefs(scene.id)).toEqual([{ book: 'TL', uid: '2' }]);
    expect(getSceneLivingLore(scene.id, { create: false }).keywordGroups).toEqual([['Silvia']]);
});

test('an empty import keeps the current cache untouched', async () => {
    __setContextOverrides({ async getWorldInfoEntriesForBook(name) { return name === 'TL' ? [rayse] : []; } });
    await applyLoomKeywordImport(importRun([['Rayse']]));
    const before = listSceneEntryRefs(scene.id);
    await applyLoomKeywordImport(importRun([]));                    // no import: no wipe
    expect(listSceneEntryRefs(scene.id)).toEqual(before);
});

test('applyLoomKeywordImport applies at most once per run, and skips when the Scene changed', async () => {
    __setContextOverrides({ async getWorldInfoEntriesForBook(name) { return name === 'TL' ? [rayse, silvia] : []; } });
    const run = importRun([['Rayse']]);
    await applyLoomKeywordImport(run);
    run.envelope.loreKeywords = [['Silvia']];       // same run object, guard already set
    await applyLoomKeywordImport(run);              // no-op: keywordImportApplied
    expect(listSceneEntryRefs(scene.id)).toEqual([{ book: 'TL', uid: '1' }]);   // still Rayse

    await applyLoomKeywordImport({ sceneId: 'other-scene', timelineId: scene.timelineId, directionId: 'd2', messageId: 1, envelope: { loreKeywords: [['Silvia']] } });
    expect(listSceneEntryRefs(scene.id)).toEqual([{ book: 'TL', uid: '1' }]);   // scene mismatch: skipped
});

test('the Scene cache renders into a Living Lore packet through {{loom.lore}}', async () => {
    __setContextOverrides({ async getWorldInfoEntriesForBook(name) { return name === 'TL' ? [rayse] : []; } });
    addEntryRefs(scene.id, [{ book: 'TL', uid: '1' }]);
    const packet = await buildSceneLivingLorePacket({ sceneId: scene.id, timelineId: scene.timelineId });
    expect(packet).toMatchObject({ protocol: 'living-lore.loom-packet.v1', book: 'TL' });
    expect(formatLivingLorePacket(packet)).toContain('Rayse is a knight.');
});

test('round-trip: Loom import -> cache -> packet renders the pulled entry', async () => {
    __setContextOverrides({ async getWorldInfoEntriesForBook(name) { return name === 'TL' ? [rayse] : []; } });
    await applyLoomKeywordImport(importRun([['Rayse']]));
    const packet = await buildSceneLivingLorePacket({ sceneId: scene.id, timelineId: scene.timelineId });
    expect(formatLivingLorePacket(packet)).toContain('Rayse is a knight.');
});

test('an empty Scene cache produces no packet (macro renders nothing)', async () => {
    const packet = await buildSceneLivingLorePacket({ sceneId: 'empty-scene', timelineId: 't1' });
    expect(packet).toBe(null);
    expect(formatLivingLorePacket(packet)).toBe('');
});

test('applyLoomLoreOps writes a cached-entry edit on commit', async () => {
    const savedBooks = {};
    __setContextOverrides({
        async loadWorldInfo(name) { return name === 'TL' ? { entries: { 1: { uid: 1, key: ['Rayse'], keysecondary: [], content: 'old' } } } : null; },
        async saveWorldInfo(name, data) { savedBooks[name] = data; },
    });
    addEntryRefs(scene.id, [{ book: 'TL', uid: '1' }]);
    const run = { sceneId: scene.id, timelineId: scene.timelineId, directionId: 'd1', messageId: 0, envelope: { loreOps: [{ op: 'lore.edit', book: 'TL', uid: '1', content: 'edited' }] } };
    await applyLoomLoreOps(run);
    expect(savedBooks.TL.entries[1].content).toBe('edited');
});

test('applyLoomLoreOps applies at most once (loreOpsApplied guard)', async () => {
    let saves = 0;
    __setContextOverrides({
        async loadWorldInfo() { return { entries: { 1: { uid: 1, key: ['Rayse'], keysecondary: [], content: 'old' } } }; },
        async saveWorldInfo() { saves += 1; },
    });
    addEntryRefs(scene.id, [{ book: 'TL', uid: '1' }]);
    const run = { sceneId: scene.id, timelineId: scene.timelineId, directionId: 'd1', messageId: 0, envelope: { loreOps: [{ op: 'lore.edit', book: 'TL', uid: '1', content: 'x' }] } };
    await applyLoomLoreOps(run);
    await applyLoomLoreOps(run);
    expect(saves).toBe(1);
});

test('applyLoomLoreOps skips when the Scene changed (scene mismatch)', async () => {
    const savedBooks = {};
    __setContextOverrides({
        async loadWorldInfo(name) { return { entries: { 1: { uid: 1, content: 'old' } } }; },
        async saveWorldInfo(name, data) { savedBooks[name] = data; },
    });
    addEntryRefs(scene.id, [{ book: 'TL', uid: '1' }]);
    const run = { sceneId: 'other-scene', timelineId: scene.timelineId, directionId: 'd1', messageId: 0, envelope: { loreOps: [{ op: 'lore.edit', book: 'TL', uid: '1', content: 'edited' }] } };
    await applyLoomLoreOps(run);
    expect(savedBooks.TL).toBeUndefined();
});
