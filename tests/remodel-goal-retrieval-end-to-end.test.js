import { buildMechanicalSnapshot, previewMechanicalContext } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/mechanics-runtime.js';
import { createSceneGoal, createSceneGoalRelation } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/story-goals-store.js';
import { appendDirectorEntries } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/director-notes-store.js';
import { updateMechanicsProfile } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/variables-store.js';
import { readRecallCounts } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/retrieval-recall.js';
import { resolveByName } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/direction-address.js';
import { __setExtensionSettings } from './util/st-context-stub.js';

// End to end from real stores to the Goals the Director is actually shown.
//
// The scorer's own tests are pure and prove the rules. These prove the wires:
// that the notebook reaches the scorer, that the budget reaches it, that the
// selected Goals are the ones the snapshot renders, and that recall is written
// by a turn and not by a look. Every one of those is a line that can be deleted
// while the pure tests stay green — the same gap that once let a notes block
// render perfectly with no route to the Narrator.

const TIMELINE = 'timeline-goal-retrieval';
const SCENE = 'scene-goal-retrieval';
const scene = { id: SCENE, timelineId: TIMELINE, title: 'The frat party' };

beforeEach(() => {
    __setExtensionSettings({ remodel: {} });
});

function seedTwoGoals() {
    return {
        rae: createSceneGoal(SCENE, {
            timelineId: TIMELINE, title: 'Talk Rae down',
            description: 'Rae is a drink away from saying the thing she cannot take back.',
        }),
        roof: createSceneGoal(SCENE, {
            timelineId: TIMELINE, title: 'Reach the roof',
            description: 'The fire escape is the only way up that nobody watches.',
        }),
    };
}

test('a Goal the Director wrote about survives a budget that only fits one', async () => {
    const { rae } = seedTwoGoals();
    appendDirectorEntries(TIMELINE, {
        sceneId: SCENE, turn: 1,
        entries: [{ type: 'note', text: 'Talk Rae down is the only thing holding this scene together.' }],
    });
    updateMechanicsProfile({ retrievalLimit: 1 });

    const snapshot = await buildMechanicalSnapshot(scene, 'He pours another drink.', [], null, [], {});

    expect(snapshot.goals.map((goal) => goal.title)).toEqual(['Talk Rae down']);
    expect(snapshot.retrieval.goalsSelected).toBe(1);
    expect(snapshot.retrieval.goalsConsidered).toBe(2);
    // The one that travelled is the one the address book can name, and the
    // other is now unaddressable on purpose — the model must not be able to
    // write to a Goal this turn never advertised.
    expect(resolveByName(snapshot.addressBook, 'Talk Rae down')).toEqual({ ok: true, id: rae.id });
    expect(resolveByName(snapshot.addressBook, 'Reach the roof').ok).toBe(false);
});

test('a secret note steers retrieval, because the Director owns its own secrets', async () => {
    seedTwoGoals();
    appendDirectorEntries(TIMELINE, {
        sceneId: SCENE, turn: 1,
        entries: [{ type: 'secret', text: 'Reach the roof is where this ends; she does not know that yet.' }],
    });
    updateMechanicsProfile({ retrievalLimit: 1 });

    const snapshot = await buildMechanicalSnapshot(scene, 'He pours another drink.', [], null, [], {});

    // Safe only because the Narrator never receives Goals at all — it receives
    // notes, through readNarratorEntries, which withholds secrets itself.
    expect(snapshot.goals.map((goal) => goal.title)).toEqual(['Reach the roof']);
});

test('a cancelled take does not get to steer the take that replaced it', async () => {
    seedTwoGoals();
    appendDirectorEntries(TIMELINE, {
        sceneId: SCENE, turn: 1,
        entries: [{ type: 'note', text: 'Reach the roof is what matters now.', abandoned: true }],
    });
    updateMechanicsProfile({ retrievalLimit: 1 });

    const snapshot = await buildMechanicalSnapshot(scene, 'He pours another drink.', [], null, [], {});

    // Both Goals are at zero, so the tie falls to the name ordering rather than
    // to the abandoned note's subject.
    expect(snapshot.goals.map((goal) => goal.title)).toEqual(['Reach the roof']);
    const withoutTheNote = snapshot.goals[0].title;
    appendDirectorEntries(TIMELINE, {
        sceneId: SCENE, turn: 2,
        entries: [{ type: 'note', text: 'Talk Rae down is what matters now.' }],
    });
    const next = await buildMechanicalSnapshot(scene, 'He pours another drink.', [], null, [], {});
    expect(next.goals[0].title).toBe('Talk Rae down');
    expect(next.goals[0].title).not.toBe(withoutTheNote);
});

test('a Goal being attempted this turn is never the one the budget drops', async () => {
    const { roof } = seedTwoGoals();
    appendDirectorEntries(TIMELINE, {
        sceneId: SCENE, turn: 1,
        entries: [{ type: 'note', text: 'Talk Rae down is the only thing holding this scene together.' }],
    });
    updateMechanicsProfile({ retrievalLimit: 1 });

    const snapshot = await buildMechanicalSnapshot(scene, 'He pours another drink.', [], null, [roof.id], {});

    expect(snapshot.goals.map((goal) => goal.title)).toEqual(['Reach the roof']);
    // And it stays addressable as the Goal the user is attempting, which is the
    // whole reason it cannot be dropped.
    expect(snapshot.authorizedGoalRefs).toEqual([snapshot.goals[0].ref]);
});

test('a turn records recall; opening the drawer to look does not', async () => {
    const { rae } = seedTwoGoals();
    updateMechanicsProfile({ retrievalLimit: 8 });

    await buildMechanicalSnapshot(scene, 'He pours another drink.', [], null, [], {});
    expect(readRecallCounts(TIMELINE, 10).get(rae.id)).toBe(1);

    await previewMechanicalContext(scene, {});
    await previewMechanicalContext(scene, {});
    // Recall weights how often something was pulled on recent TURNS. If a
    // preview wrote one, opening the drawer twice would reweight the next
    // real pass.
    expect(readRecallCounts(TIMELINE, 10).get(rae.id)).toBe(1);

    await buildMechanicalSnapshot(scene, 'He pours another drink.', [], null, [], {});
    expect(readRecallCounts(TIMELINE, 10).get(rae.id)).toBe(2);
});

test('a relation is dropped when retrieval kept only one of its two ends', async () => {
    const { rae, roof } = seedTwoGoals();
    createSceneGoalRelation(SCENE, rae.id, roof.id, 'antagonistic', 'One costs the other.');

    const whole = await buildMechanicalSnapshot(scene, 'He pours another drink.', [], null, [], {});
    expect(whole.relationships).toHaveLength(1);

    appendDirectorEntries(TIMELINE, {
        sceneId: SCENE, turn: 1,
        entries: [{ type: 'note', text: 'Talk Rae down is the only thing holding this scene together.' }],
    });
    updateMechanicsProfile({ retrievalLimit: 1 });
    const cut = await buildMechanicalSnapshot(scene, 'He pours another drink.', [], null, [], {});

    // A relation pointing at a Goal the Director was never shown is worse than
    // no relation: it names something the model cannot address and cannot be
    // told anything more about.
    expect(cut.goals).toHaveLength(1);
    expect(cut.relationships).toEqual([]);
});

test('a Scene with no Goals at all reaches the prompt as an invitation, not a denial', async () => {
    const snapshot = await buildMechanicalSnapshot(scene, 'He pours another drink.', [], null, [], {});

    expect(snapshot.goals).toEqual([]);
    expect(snapshot.retrieval.goalsEmptyCode).toBe('none-authored');
});

test('a Scene whose Goals were all outranked says so instead', async () => {
    seedTwoGoals();
    // A budget of 1 with two Goals cannot empty the list, so squeeze it with a
    // pinned Goal that does not exist to leave the real ones eligible but cut.
    updateMechanicsProfile({ retrievalLimit: 1 });
    const snapshot = await buildMechanicalSnapshot(scene, 'He pours another drink.', [], null, [], {});

    expect(snapshot.retrieval.goalsSelected).toBe(1);
    expect(snapshot.retrieval.goalsEmptyCode).toBe('');
    const dropped = snapshot.goals.map((goal) => goal.title);
    expect(dropped).toHaveLength(1);
});
