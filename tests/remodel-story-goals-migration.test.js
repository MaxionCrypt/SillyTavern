import { createTimelineGoal, getStoryGoal, getStoryGoalsStore, updateStoryGoal } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/story-goals-store.js';
import { listVariableValues } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/variables-store.js';
import { __getExtensionSettings } from './util/st-context-stub.js';

// A Goal is just a Goal. It used to be bindable to a Variable with a completion
// threshold, so a reach converted a hit through an impact scale and moved that
// Variable automatically. Both the scale and the binding are gone: if the
// Loom wants to treat a Variable as a Goal's constitution it says so in its
// notes and reads the value, rather than code wiring the two together.

const TL = 'tl-goals-migration';

function seedRawStore(goals) {
    const settings = __getExtensionSettings();
    settings.remodel ??= {};
    settings.remodel.storyGoalsV3 = {
        version: 3, timelines: {}, scenes: {}, relations: {}, events: {},
        goals: Object.fromEntries(goals.map((goal) => [goal.id, goal])),
    };
}

test('a stored Goal carrying a tracked resolution loads without the field and keeps everything else', () => {
    seedRawStore([{
        id: 'goal-tracked', timelineId: TL, title: 'Repair the keep', description: 'Before winter',
        successRate: 45, status: 'active', visibility: 'public',
        resolution: { kind: 'tracked', variableId: 'var-9', field: 'value', direction: 'increase', completionThreshold: 100 },
    }]);

    getStoryGoalsStore();
    const goal = getStoryGoal('goal-tracked');

    expect(goal.resolution).toBeUndefined();
    expect(goal).toMatchObject({ title: 'Repair the keep', description: 'Before winter', successRate: 45, status: 'active', visibility: 'public' });
});

test('a stored Goal that never had a resolution loads unharmed', () => {
    seedRawStore([{ id: 'goal-plain', timelineId: TL, title: 'Find the ledger', successRate: 30 }]);

    expect(() => getStoryGoalsStore()).not.toThrow();
    expect(getStoryGoal('goal-plain')).toMatchObject({ title: 'Find the ledger', successRate: 30 });
    expect(getStoryGoal('goal-plain').resolution).toBeUndefined();
});

test('a resolution supplied on creation is dropped rather than stored', () => {
    seedRawStore([]);
    const goal = createTimelineGoal(TL, {
        title: 'Bleed her out', successRate: 60,
        holderRefs: [{ kind: 'character', id: 'char-n', label: 'Wren' }],
        resolution: { kind: 'tracked', variableId: 'var-9', direction: 'decrease', completionThreshold: 0 },
    }, { sceneId: 'scene-1' });

    expect(goal.resolution).toBeUndefined();
    expect(getStoryGoal(goal.id).resolution).toBeUndefined();
});

test('a resolution supplied on update is dropped rather than stored', () => {
    seedRawStore([]);
    const goal = createTimelineGoal(TL, {
        title: 'Hold the gate', successRate: 50,
        holderRefs: [{ kind: 'character', id: 'char-n', label: 'Wren' }],
    }, { sceneId: 'scene-1' });

    const after = updateStoryGoal(goal.id, { resolution: { kind: 'tracked', variableId: 'var-9' } }, { type: 'test' });

    expect(after.resolution).toBeUndefined();
    expect(getStoryGoal(goal.id).resolution).toBeUndefined();
});

test('a legacy embedded Constitution pool still becomes a real Variable', () => {
    // The pool was the owner's data. Dropping the binding must not drop the
    // numbers with it — the migration keeps making a Variable, the Goal simply
    // no longer points at it, and the owner can see it in the Codex.
    seedRawStore([{
        id: 'goal-constitution', timelineId: TL, title: 'Break the siege', successRate: 40,
        constitution: { label: 'Siege Resolve', current: 80, max: 120, winDirection: 'drain' },
    }]);

    getStoryGoalsStore();

    const migrated = listVariableValues({ timelineId: TL }).find((item) => item.name === 'Siege Resolve');
    expect(migrated).toBeTruthy();
    expect(migrated.value).toBe(80);
    expect(getStoryGoal('goal-constitution').resolution).toBeUndefined();
});
