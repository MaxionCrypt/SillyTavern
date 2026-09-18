import { test, expect, beforeEach, afterEach } from '@jest/globals';
import { initLiveDirection, setLiveDirectionTestAdapters, runLoomReconciliation, __buildLoomSnapshot } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js';
import { __setExtensionSettings, __setContextOverrides } from './util/st-context-stub.js';
import { __setWorldInfoState } from './util/world-info-stub.js';
import { listSceneEntryRefs, getSceneLivingLore, addEntryRefs } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-cache-store.js';
import { buildSceneLivingLorePacket } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-cache-packet.js';
import { formatLivingLorePacket } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-proposals.js';

const scene = { id: 's1', timelineId: 't1' };
const rayse = { uid: 1, world: 'TL', key: ['Rayse'], keysecondary: [], selective: false, selectiveLogic: 0, content: 'Rayse is a knight.', comment: 'Rayse', disable: false };

function loomReply(fence) {
    return ['```state', JSON.stringify(fence), '```'].join('\n');
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

test('Loom keyword groups populate the Scene Living Lore cache', async () => {
    __setContextOverrides({ async getWorldInfoEntriesForBook(name) { return name === 'TL' ? [rayse] : []; } });
    setLiveDirectionTestAdapters({ loomReconciliation: async () => loomReply({ requests: [], loreProposals: [], loreKeywords: [['Rayse']], flow: { continue: false } }) });
    const snapshot = await __buildLoomSnapshot(scene);
    await runLoomReconciliation({ scene, snapshot, draft: 'The draft stands.' });
    expect(listSceneEntryRefs(scene.id)).toEqual([{ book: 'TL', uid: '1' }]);
    expect(getSceneLivingLore(scene.id, { create: false }).keywordGroups).toEqual([['Rayse']]);
});

test('a group queried twice across turns loads its book only once', async () => {
    let loadCount = 0;
    __setContextOverrides({ async getWorldInfoEntriesForBook(name) { loadCount += 1; return name === 'TL' ? [rayse] : []; } });
    setLiveDirectionTestAdapters({ loomReconciliation: async () => loomReply({ requests: [], loreProposals: [], loreKeywords: [['Rayse']], flow: { continue: false } }) });
    const snapshot = await __buildLoomSnapshot(scene);
    await runLoomReconciliation({ scene, snapshot, draft: 'The draft stands.' });
    const first = loadCount;
    await runLoomReconciliation({ scene, snapshot, draft: 'The draft stands.' });
    expect(loadCount).toBe(first); // second turn: group already seen, no re-query
});

test('the Scene cache renders into a Living Lore packet through {{loom.lore}}', async () => {
    __setContextOverrides({ async getWorldInfoEntriesForBook(name) { return name === 'TL' ? [rayse] : []; } });
    addEntryRefs(scene.id, [{ book: 'TL', uid: '1' }]);
    const packet = await buildSceneLivingLorePacket({ sceneId: scene.id, timelineId: scene.timelineId });
    expect(packet).toMatchObject({ protocol: 'living-lore.loom-packet.v1', book: 'TL' });
    expect(formatLivingLorePacket(packet)).toContain('Rayse is a knight.');
});

test('round-trip: Loom groups -> cache -> packet renders the pulled entry', async () => {
    __setContextOverrides({ async getWorldInfoEntriesForBook(name) { return name === 'TL' ? [rayse] : []; } });
    setLiveDirectionTestAdapters({ loomReconciliation: async () => loomReply({ requests: [], loreProposals: [], loreKeywords: [['Rayse']], flow: { continue: false } }) });
    const snapshot = await __buildLoomSnapshot(scene);
    await runLoomReconciliation({ scene, snapshot, draft: 'The draft stands.' });
    const packet = await buildSceneLivingLorePacket({ sceneId: scene.id, timelineId: scene.timelineId });
    expect(formatLivingLorePacket(packet)).toContain('Rayse is a knight.');
});

test('an empty Scene cache produces no packet (macro renders nothing)', async () => {
    const packet = await buildSceneLivingLorePacket({ sceneId: 'empty-scene', timelineId: 't1' });
    expect(packet).toBe(null);
    expect(formatLivingLorePacket(packet)).toBe('');
});
