import { buildMechanicalSnapshot } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/mechanics-runtime.js';
import { buildLoomContext } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/loom-context.js';
import { createTimelineGoal, getSceneGoals } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/story-goals-store.js';
import { createVariableValue } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/variables-store.js';
import { __setExtensionSettings } from './util/st-context-stub.js';

// End to end from a real empty Timeline to the text the Loom reads.
//
// The renderer tests hand-build a snapshot with `retrieval.emptyCode` already
// on it, so they prove the wording is right given the field and nothing about
// the field arriving. Removing the line in mechanics-runtime that forwards it
// left every one of them green. This is the test that fails when the wire is
// cut — the same gap that once let a notes block render perfectly with no route
// to the Narrator.

const TIMELINE = 'timeline-empty-1';
const SCENE = 'scene-empty-1';

beforeEach(() => {
    __setExtensionSettings({ remodel: {} });
});

const scene = { id: SCENE, timelineId: TIMELINE, title: 'The frat party' };

test('a Timeline with no Variables reaches the prompt as an invitation, not a denial', async () => {
    const snapshot = await buildMechanicalSnapshot(scene, 'Wren scans the room.', [], null, []);
    expect(snapshot.retrieval.emptyCode).toBe('none-authored');

    const { mechanicsSkill } = buildLoomContext({ mechanics: snapshot }, { mechanicsEnabled: true });
    expect(mechanicsSkill).toMatch(/no Variables yet/i);
    expect(mechanicsSkill).toContain('variable.create');
});

test('an empty Goal board creates only fictionally meaningful unresolved outcomes', async () => {
    const snapshot = await buildMechanicalSnapshot(scene, 'Wren scans the room.', [], null, []);
    const { mechanicsSkill } = buildLoomContext({ mechanics: snapshot }, { mechanicsEnabled: true });
    expect(mechanicsSkill).toContain('meaningful unresolved outcome');
    expect(mechanicsSkill).toMatch(/never merely because a named character lacks one/i);
    expect(mechanicsSkill).not.toMatch(/standing want/i);
});

test('once a Variable exists, an unmatched turn says so instead', async () => {
    // Lore-linked and `corroborated` on purpose. The store refuses an unlinked
    // Variable in any mode but `always`, and `always` would retrieve — so this
    // is the only combination that is both storable and legitimately absent
    // from a turn where nothing corroborates it.
    createVariableValue({
        timelineId: TIMELINE, name: 'Faction Heat', description: 'How close the house is to turning on her.',
        valueType: 'number', value: 3,
        loreLinks: [{ book: 'Halloway', uid: 7 }], retrieval: { mode: 'corroborated' }, authority: 'world',
    }, { actor: 'user' });

    const snapshot = await buildMechanicalSnapshot(scene, 'Wren scans the room.', [], null, []);
    expect(snapshot.retrieval.emptyCode).not.toBe('none-authored');

    const { mechanicsSkill } = buildLoomContext({ mechanics: snapshot }, { mechanicsEnabled: true });
    expect(mechanicsSkill).not.toMatch(/create it with variable\.create/i);
});

test('a Story-created Timeline Goal is retrievable in a later Roleplay Scene without copying its Scene link', async () => {
    const storySceneId = 'scene-story-origin';
    const roleplayScene = { id: 'scene-roleplay-later', timelineId: TIMELINE, title: 'The next morning' };
    const goal = createTimelineGoal(TIMELINE, {
        title: 'Find Rae before dawn',
        description: 'Rae vanished after the party and must be found before dawn.',
        successRate: 45,
        originSceneId: storySceneId,
    }, { sceneId: storySceneId, actor: 'loom' });

    expect(getSceneGoals(storySceneId).map((item) => item.id)).toContain(goal.id);
    expect(getSceneGoals(roleplayScene.id)).toEqual([]);

    const snapshot = await buildMechanicalSnapshot(
        roleplayScene,
        'Wren searches the roof for Rae before dawn.',
        [], null, [], { history: ['Rae never came back from the party.'] },
    );

    expect(snapshot.goals.map((item) => item.title)).toContain('Find Rae before dawn');
    expect(snapshot.retrieval.goalsConsidered).toBe(1);
    // Retrieval crosses the Scene boundary; persistence does not silently add
    // a presentation link to the later Scene.
    expect(getSceneGoals(roleplayScene.id)).toEqual([]);
});
