import {
    createTimelineGoal,
    deleteStoryGoal,
    getGoalEvents,
    getStoryGoal,
    updateStoryGoal,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/story-goals-store.js';
import { __setExtensionSettings } from './util/st-context-stub.js';

const TIMELINE = 'timeline-events-1';
const SCENE = 'scene-events-1';

beforeEach(() => {
    __setExtensionSettings({ remodel: {} });
});

function seedGoal(context = {}) {
    return createTimelineGoal(TIMELINE, {
        title: 'Hold the gate', description: 'Until the column arrives', successRate: 40,
        holderRefs: [{ kind: 'character', id: 'char-wren', label: 'Wren' }],
    }, { sceneId: SCENE, ...context });
}

// Owner edits go straight to the store rather than through the capability
// layer — the owner is not a model being constrained — so they produce no
// receipt. The event ledger is what keeps a Goal's history honest about who
// changed it, and it has to tell the two apart.

test('an owner edit is recorded as the owner\'s', () => {
    const goal = seedGoal();
    updateStoryGoal(goal.id, { successRate: 55 }, { sceneId: SCENE, actor: 'user', reason: 'The column is closer than I thought.' });

    const events = getGoalEvents(goal.id);
    expect(events.at(-1)).toMatchObject({ actor: 'user', reason: 'The column is closer than I thought.' });
});

test('an AI change is distinguishable from an owner edit in the same ledger', () => {
    const goal = seedGoal();
    updateStoryGoal(goal.id, { successRate: 55 }, { sceneId: SCENE, actor: 'user', reason: 'Owner.' });
    updateStoryGoal(goal.id, { successRate: 61 }, { sceneId: SCENE, actor: 'mechanics', reason: 'Director.' });

    const actors = getGoalEvents(goal.id).map((event) => event.actor);
    expect(actors).toContain('user');
    expect(actors).toContain('mechanics');
    expect(new Set(actors).size).toBeGreaterThan(1);
});

test('the ledger records what changed, not merely that something did', () => {
    // An event with no before/after is unreadable six turns later.
    const goal = seedGoal();
    updateStoryGoal(goal.id, { successRate: 72 }, { sceneId: SCENE, actor: 'user', reason: 'She got inside the wall.' });

    const event = getGoalEvents(goal.id).at(-1);
    expect(event.before.successRate).toBe(40);
    expect(event.after.successRate).toBe(72);
    expect(event.createdAt).toBeTruthy();
});

test('creating and deleting are both on the record', () => {
    const goal = seedGoal();
    expect(getGoalEvents(goal.id).map((event) => event.type)).toContain('goal.created');

    deleteStoryGoal(goal.id, { sceneId: SCENE, actor: 'user', reason: 'Overtaken by the retreat.' });
    expect(getStoryGoal(goal.id)).toBeFalsy();
});

// clampRate returns null for an unusable value rather than reading it as zero.
// Every write path has to supply its own default, or a Goal ends up with no
// rate at all — and resolveReach throws on one.

test('a Goal created with a blank rate falls back rather than storing nothing', () => {
    // The deck's create form sends a string. Clearing the field sends ''.
    const goal = createTimelineGoal(TIMELINE, {
        title: 'Find the ledger', successRate: '',
        holderRefs: [{ kind: 'character', id: 'char-wren', label: 'Wren' }],
    }, { sceneId: SCENE });

    expect(typeof goal.successRate).toBe('number');
    expect(goal.successRate).toBeGreaterThanOrEqual(5);
});

test('an update with an unusable rate leaves the rate alone', () => {
    const goal = seedGoal();
    updateStoryGoal(goal.id, { successRate: '' }, { sceneId: SCENE, actor: 'user' });

    expect(getStoryGoal(goal.id).successRate).toBe(40);
});
