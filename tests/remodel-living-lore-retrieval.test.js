import { __setExtensionSettings, __setContextOverrides } from './util/st-context-stub.js';
import { __setWorldInfoState } from './util/world-info-stub.js';
import { createTimeline, updateTimeline, createArc, createScene } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/timeline-state.js';
import { scopedBookNames, activateKeywordGroups } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-retrieval.js';

function seedScene({ lorebookName = 'TL' } = {}) {
    __setExtensionSettings({ remodel: {} });
    const tl = createTimeline('T');
    if (lorebookName) updateTimeline(tl.id, { lorebookName });
    const arc = createArc(tl.id, 'A');
    const scene = createScene(arc.id, 'roleplay', 'S');
    return { timelineId: tl.id, sceneId: scene.id };
}

beforeEach(() => { __setWorldInfoState({ selected_world_info: [] }); });

test('scopedBookNames unions active books with the timeline book, deduped', () => {
    const { sceneId, timelineId } = seedScene({ lorebookName: 'TL' });
    __setWorldInfoState({ selected_world_info: ['Global', 'Global'] });
    __setContextOverrides({ chatMetadata: { world_info: 'Chat' }, characters: [{ data: { extensions: { world: 'CharBook' } } }], characterId: 0 });
    expect(new Set(scopedBookNames({ sceneId, timelineId }))).toEqual(new Set(['Global', 'Chat', 'CharBook', 'TL']));
});

const entry = (over) => ({ uid: 1, world: 'TL', key: ['Rayse'], keysecondary: [], selective: false, selectiveLogic: 0, content: 'x', disable: false, ...over });

function withBook(entries) {
    __setContextOverrides({ async getWorldInfoEntriesForBook(name) { return name === 'TL' ? entries : []; } });
}

test('a group with two keys activates an AND_ALL entry satisfied within that group', async () => {
    const { sceneId, timelineId } = seedScene();
    withBook([entry({ uid: 1, key: ['event'], keysecondary: ['Rayse'], selective: true, selectiveLogic: 3 }), entry({ uid: 2, key: ['Silvia'] })]);
    const refs = await activateKeywordGroups([['event', 'Rayse']], { sceneId, timelineId });
    expect(refs.map((r) => r.uid)).toEqual(['1']);
});

test('two separate groups do not cross-activate an AND_ALL entry needing one key from each', async () => {
    const { sceneId, timelineId } = seedScene();
    withBook([entry({ uid: 1, key: ['event'], keysecondary: ['Silvia'], selective: true, selectiveLogic: 3 })]);
    const refs = await activateKeywordGroups([['event', 'Rayse'], ['Rayse', 'Silvia']], { sceneId, timelineId });
    expect(refs).toEqual([]);
});

test('an entry reachable from two groups appears once (dedup) and carries its ref fields', async () => {
    const { sceneId, timelineId } = seedScene();
    withBook([entry({ uid: 7, key: ['Rayse'], comment: 'Rayse', content: 'a knight' })]);
    const refs = await activateKeywordGroups([['Rayse'], ['Rayse', 'x']], { sceneId, timelineId });
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ book: 'TL', uid: '7', name: 'Rayse', keys: ['Rayse'], content: 'a knight' });
});
