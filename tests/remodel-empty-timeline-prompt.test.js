import { buildMechanicalSnapshot } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/mechanics-runtime.js';
import { buildDirectionSources } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/direction-sources.js';
import { createVariableValue } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/variables-store.js';
import { __setExtensionSettings } from './util/st-context-stub.js';

// End to end from a real empty Timeline to the text the Director reads.
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

    const { mechanicsSkill } = buildDirectionSources({ mechanics: snapshot }, { mechanicsEnabled: true });
    expect(mechanicsSkill).toMatch(/no Variables yet/i);
    expect(mechanicsSkill).toContain('variable.create');
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

    const { mechanicsSkill } = buildDirectionSources({ mechanics: snapshot }, { mechanicsEnabled: true });
    expect(mechanicsSkill).not.toMatch(/create it with variable\.create/i);
});
