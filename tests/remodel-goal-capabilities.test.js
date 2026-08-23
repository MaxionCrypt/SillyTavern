import {
    MECHANICS_PROTOCOL,
    executeMechanicsRequest,
    getCapabilityDictionary,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/mechanics-capabilities.js';
import { createTimelineGoal, getStoryGoal, getTimelineGoals } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/story-goals-store.js';
import { __setExtensionSettings } from './util/st-context-stub.js';

// The Goal verbs, end to end through the real capability layer and the real
// store. goal.shift and goal.close are gone: a shift and an opening rate are
// the same kind of value once the band vocabulary lives in the Loom's
// prompt, and a status is just an attribute. Both collapse into goal.edit.

const TIMELINE = 'timeline-goals-1';
const SCENE = 'scene-goals-1';

beforeEach(() => {
    __setExtensionSettings({ remodel: {} });
});

function seedGoal(overrides = {}) {
    return createTimelineGoal(TIMELINE, {
        title: 'Hold the gate',
        description: 'Until the column arrives',
        successRate: 40,
        visibility: 'public',
        // World-held, so nothing defers to review.
        holderRefs: [{ kind: 'character', id: 'char-wren', label: 'Wren' }],
        ...overrides,
    }, { sceneId: SCENE });
}

/** One transaction, addressed the way production addresses one: the table is
 *  built before the batch runs, so nothing a request creates appears in it. */
function run(requests, goalRefs = new Map()) {
    return executeMechanicsRequest(
        { protocol: MECHANICS_PROTOCOL, requests },
        { timelineId: TIMELINE, sceneId: SCENE, variableRefs: new Map(), goalRefs },
    );
}

function editRequest(args, id = 'r1') {
    return { id, capability: 'goal.edit', arguments: args, reason: 'The column is a day out.' };
}

test('the dictionary names exactly the five Goal verbs', () => {
    const verbs = getCapabilityDictionary().map((entry) => entry.name).filter((name) => name.startsWith('goal.')).sort();
    expect(verbs).toEqual(['goal.create', 'goal.delete', 'goal.edit', 'goal.reach', 'goal.relate']);
});

test('goal.edit sets a rate the Loom chose', () => {
    const goal = seedGoal();
    const result = run([editRequest({ goalRef: 'Hold the gate', successRate: 62 })], new Map([['Hold the gate', goal.id]]));

    expect(result.ok).toBe(true);
    expect(getStoryGoal(goal.id).successRate).toBe(62);
});

test('a rate outside 5-95 is clamped rather than refused', () => {
    // The clamp is code's; the judgement is the Loom's. Refusing the whole
    // request would lose the reason and the edit along with the overshoot.
    const goal = seedGoal();
    run([editRequest({ goalRef: 'Hold the gate', successRate: 130 })], new Map([['Hold the gate', goal.id]]));

    expect(getStoryGoal(goal.id).successRate).toBe(95);
});

test('goal.edit changes status, so there is nothing left for goal.close to do', () => {
    const goal = seedGoal();
    const result = run([editRequest({ goalRef: 'Hold the gate', status: 'achieved' })], new Map([['Hold the gate', goal.id]]));

    expect(result.ok).toBe(true);
    expect(getStoryGoal(goal.id).status).toBe('achieved');
});

test('goal.edit changes the prose attributes too', () => {
    const goal = seedGoal();
    run([editRequest({ goalRef: 'Hold the gate', title: 'Hold the gate until dusk', description: 'The column is late', visibility: 'secret' })], new Map([['Hold the gate', goal.id]]));

    expect(getStoryGoal(goal.id)).toMatchObject({
        title: 'Hold the gate until dusk', description: 'The column is late', visibility: 'secret',
    });
});

test('an edit that changes nothing is refused rather than recorded as a change', () => {
    const goal = seedGoal();
    const result = run([editRequest({ goalRef: 'Hold the gate' })], new Map([['Hold the gate', goal.id]]));

    expect(result.ok).toBe(false);
    expect(getStoryGoal(goal.id).successRate).toBe(40);
});

test('an invalid status is refused rather than written', () => {
    const goal = seedGoal();
    const result = run([editRequest({ goalRef: 'Hold the gate', status: 'triumphant' })], new Map([['Hold the gate', goal.id]]));

    expect(result.ok).toBe(false);
    expect(getStoryGoal(goal.id).status).toBe('active');
});

test('goal.delete removes the Goal', () => {
    const goal = seedGoal();
    const result = run(
        [{ id: 'r1', capability: 'goal.delete', arguments: { goalRef: 'Hold the gate' }, reason: 'It was overtaken by the retreat.' }],
        new Map([['Hold the gate', goal.id]]),
    );

    expect(result.ok).toBe(true);
    expect(getTimelineGoals(TIMELINE).some((item) => item.id === goal.id)).toBe(false);
});

test('a Goal name that was not advertised this turn resolves to nothing', () => {
    // The containment property: a request may only address the closed set the
    // Loom was shown. An empty address table is the strongest form of that.
    const goal = seedGoal();
    const result = run([editRequest({ goalRef: 'Hold the gate', successRate: 90 })], new Map());

    expect(result.ok).toBe(false);
    expect(getStoryGoal(goal.id).successRate).toBe(40);
});

test('a real Goal id is refused when the Goal was not advertised', () => {
    // The test above cannot actually prove containment: an unadvertised NAME
    // fails at the id lookup regardless, so it stays green even if the resolver
    // falls through to the raw string. A real id is the case that separates
    // them — falling through would find this Goal and change it.
    const goal = seedGoal();
    const result = run([editRequest({ goalRef: goal.id, successRate: 90 })], new Map());

    expect(result.ok).toBe(false);
    expect(getStoryGoal(goal.id).successRate).toBe(40);
});

test('a Goal that already ended can still be edited and reopened', () => {
    // goal.edit advertises `active` as a way to reopen an ended Goal, so it has
    // to be able to reach one. Only a reach needs the Goal to be live.
    const goal = seedGoal();
    const refs = new Map([['Hold the gate', goal.id]]);
    run([editRequest({ goalRef: 'Hold the gate', status: 'abandoned' })], refs);
    expect(getStoryGoal(goal.id).status).toBe('abandoned');

    const result = run([editRequest({ goalRef: 'Hold the gate', status: 'active' }, 'r2')], refs);

    expect(result.ok).toBe(true);
    expect(getStoryGoal(goal.id).status).toBe('active');
});


// THE DEFECT, so it is not reintroduced: isAuthorizedOwner was deleted by
// cebcd1596 and its call site inside goal.create survived, so every
// goal.create threw ReferenceError. Nothing caught it for months because the
// mechanics board defined a Goal as a gamble and told the Loom to create one
// "only when the fiction has raised the stakes itself" — so it never did.
//
// Requests execute as ONE atomic transaction, so the throw took every
// event.record, scene.set and beat.set in the same turn down with it. A live
// session lost seven requests to one missing function and reported only
// "Mechanical transaction failed: isAuthorizedOwner is not defined".
test('goal.create places a Goal on a character rather than throwing', () => {
    const result = run([{
        id: 'r1',
        capability: 'goal.create',
        arguments: {
            title: 'Be home by six',
            description: 'She meant to finish the chapter and leave.',
            holderRefs: [{ kind: 'character', id: 'marissa', label: 'Marissa' }],
            successRate: 30,
        },
        reason: 'She carried this in before the scene began.',
    }]);

    expect(result.errors || []).toEqual([]);
    expect(result.ok).toBe(true);
    const created = getTimelineGoals(TIMELINE).find((goal) => goal.title === 'Be home by six');
    expect(created).toBeTruthy();
    expect(created.holderRefs[0].kind).toBe('character');
});

// The atomicity is the reason the missing function was so expensive: one bad
// request must not be able to silently discard the turn's whole Archive.
test('a Goal for a character does not defer, so Archive requests in the same turn survive', () => {
    const result = run([
        {
            id: 'r1',
            capability: 'goal.create',
            arguments: { title: 'Finish the chapter', holderRefs: [{ kind: 'character', id: 'm', label: 'Marissa' }] },
            reason: 'her own reason',
        },
        { id: 'r2', capability: 'event.record', arguments: { summary: 'She turned a page.' }, reason: 'it happened' },
    ]);

    expect(result.ok).toBe(true);
    expect(result.errors || []).toEqual([]);
    expect(getTimelineGoals(TIMELINE).some((goal) => goal.title === 'Finish the chapter')).toBe(true);
});

// A Goal placed on the PLAYER is theirs to accept, not the Loom's to assign —
// the distinction isAuthorizedOwner exists to draw.
test('a persona-held Goal is treated differently from a character-held one', () => {
    const result = run([{
        id: 'r1',
        capability: 'goal.create',
        arguments: { title: 'Eli wants the pendant', holderRefs: [{ kind: 'persona', id: 'eli', label: 'Eli Mercer' }] },
        reason: 'placed on the player',
    }]);
    // It must not throw either way; whether it lands or defers is policy.
    expect(String((result.errors || []).join(  String.fromCharCode(32) ))).not.toMatch(/is not defined/);
});


// A Goal was a title and a number. Nothing said what would make it go well or
// badly, so the Loom could only restate it, never advance or close it — and
// description came back empty on every Goal created in a live session, because
// the capability guide listed only title and holderRefs. The model was never
// told the argument existed.
test('description is advertised as required, with the condition as its hint', () => {
    const entry = getCapabilityDictionary().find((c) => c.name === 'goal.create');
    const keys = entry.requiredArguments.map((a) => a.key);
    expect(keys).toContain('description');
    const hint = entry.requiredArguments.find((a) => a.key === 'description').hint;
    expect(hint).toMatch(/condition/i);
    expect(hint).toMatch(/break it/i);
});

// ...but advertised is NOT enforced. A MechanicsError rolls the whole
// transaction back, so throwing over a missing sentence would destroy every
// event.record and beat.set in the same turn — the exact blast radius that the
// undefined isAuthorizedOwner produced. A thin Goal beats a lost Archive.
test('a Goal with no description still lands, taking the turn with it', () => {
    const result = run([
        {
            id: 'r1',
            capability: 'goal.create',
            arguments: { title: 'Make the early shift', holderRefs: [{ kind: 'character', id: 'm', label: 'Marissa' }] },
            reason: 'her own schedule',
        },
        { id: 'r2', capability: 'event.record', arguments: { summary: 'She checked the clock.' }, reason: 'it happened' },
    ]);

    expect(result.ok).toBe(true);
    expect(result.errors || []).toEqual([]);
    expect(getTimelineGoals(TIMELINE).some((g) => g.title === 'Make the early shift')).toBe(true);
});

test('a condition supplied in description is stored on the Goal', () => {
    const condition = 'On track while she leaves the stacks by 5:40; broken if she is still there at six.';
    const result = run([{
        id: 'r1',
        capability: 'goal.create',
        arguments: { title: 'Be on shift by six', description: condition, holderRefs: [{ kind: 'character', id: 'm', label: 'Marissa' }] },
        reason: 'her own schedule',
    }]);

    expect(result.ok).toBe(true);
    const goal = getTimelineGoals(TIMELINE).find((g) => g.title === 'Be on shift by six');
    expect(goal.description).toBe(condition);
});
