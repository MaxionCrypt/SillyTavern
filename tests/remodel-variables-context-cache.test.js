import {
    createVariableValue,
    deleteVariableValue,
    setVariableField,
    updateVariableValue,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/variables-store.js';
import {
    getLastVariableContext,
    resolveVariableContext,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/variables-context.js';
import { __setExtensionSettings } from './util/st-context-stub.js';

// The bug these cover, from the owner's own session: they deleted a Variable,
// the store updated, and the Timeline State drawer went on rendering a
// retrieval snapshot recorded twenty-seven minutes earlier — still listing the
// record that no longer existed. `lastByTimeline` in variables-context.js was
// written after every retrieval and invalidated by nothing at all.
//
// There is no vector backend under Node, so `queryVariableVectors` degrades and
// retrieval falls back to its deterministic path. That is why every fixture
// below uses `always` retrieval: it is the one mode that surfaces without
// semantic evidence, so the snapshot under test is never empty for an
// unrelated reason.

let counter = 0;

/** A fresh Timeline per test, so no snapshot can leak between them. */
function freshTimeline() {
    __setExtensionSettings({ remodel: {} });
    counter += 1;
    return `timeline-cache-${counter}`;
}

function makeVariable(timelineId, name, value = 12) {
    const variable = createVariableValue({
        timelineId, name, description: `${name}, for the cache tests.`,
        valueType: 'number', value,
        retrieval: { mode: 'always', semanticThreshold: 0.7, continuity: true },
        authority: 'world',
    }, { actor: 'user' });
    if (!variable) throw new Error(`fixture failed: ${name} was not created`);
    return variable;
}

async function retrieve(timelineId) {
    return resolveVariableContext({ timelineId, action: 'Aiden braces against the door.' });
}

/** Names the snapshot currently reachable through the drawer's own accessor. */
function cachedNames(timelineId) {
    return (getLastVariableContext(timelineId)?.listed || []).map((item) => item.variable.name);
}

test('a retrieval is cached under its Timeline and readable back', async () => {
    const timelineId = freshTimeline();
    makeVariable(timelineId, "Aiden's HP");
    const resolved = await retrieve(timelineId);

    expect(resolved.listed.map((item) => item.variable.name)).toContain("Aiden's HP");
    expect(getLastVariableContext(timelineId)).not.toBeNull();
    expect(cachedNames(timelineId)).toEqual(["Aiden's HP"]);
});

test('deleting a Variable makes the stale snapshot unreachable through getLastVariableContext', async () => {
    const timelineId = freshTimeline();
    const doomed = makeVariable(timelineId, 'Faction Heat', 4);
    await retrieve(timelineId);

    // The precondition the owner hit: the snapshot names the record that is
    // about to stop existing. Without this the assertion below could pass
    // because retrieval never surfaced it in the first place.
    expect(cachedNames(timelineId)).toContain('Faction Heat');

    expect(deleteVariableValue(doomed.id, { timelineId })).toBe(true);

    expect(getLastVariableContext(timelineId)).toBeNull();
    expect(cachedNames(timelineId)).not.toContain('Faction Heat');
});

test('editing a Variable drops the snapshot, which holds whole records and not just names', async () => {
    const timelineId = freshTimeline();
    const variable = makeVariable(timelineId, 'Morale', 7);
    await retrieve(timelineId);
    expect(getLastVariableContext(timelineId).listed[0].variable.value).toBe(7);

    expect(setVariableField(variable.id, 'value', 2, { timelineId })).not.toBeNull();

    // A snapshot that survived would keep reporting 7 — a wrong number is
    // worse than no number, which is the whole reason this is dropped.
    expect(getLastVariableContext(timelineId)).toBeNull();
});

test('renaming a Variable drops the snapshot', async () => {
    const timelineId = freshTimeline();
    const variable = makeVariable(timelineId, 'Suspicion');
    await retrieve(timelineId);
    expect(cachedNames(timelineId)).toEqual(['Suspicion']);

    expect(updateVariableValue(variable.id, { name: 'Town Suspicion' }, { timelineId })).not.toBeNull();

    expect(getLastVariableContext(timelineId)).toBeNull();
});

test('creating a Variable drops the snapshot, so a new record cannot be missing from it', async () => {
    const timelineId = freshTimeline();
    makeVariable(timelineId, "Aiden's HP");
    await retrieve(timelineId);
    expect(getLastVariableContext(timelineId)).not.toBeNull();

    makeVariable(timelineId, 'Faction Heat', 1);

    expect(getLastVariableContext(timelineId)).toBeNull();
});

test('a change in one Timeline does not throw away another Timeline\'s snapshot', async () => {
    __setExtensionSettings({ remodel: {} });
    counter += 1;
    const left = `timeline-cache-left-${counter}`;
    const right = `timeline-cache-right-${counter}`;
    const doomed = makeVariable(left, 'Left State');
    makeVariable(right, 'Right State');
    await retrieve(left);
    await retrieve(right);
    expect(cachedNames(left)).toEqual(['Left State']);
    expect(cachedNames(right)).toEqual(['Right State']);

    deleteVariableValue(doomed.id, { timelineId: left });

    expect(getLastVariableContext(left)).toBeNull();
    // Invalidation is scoped, not a blanket clear: a Timeline nothing touched
    // keeps the pass it actually ran.
    expect(cachedNames(right)).toEqual(['Right State']);
});

test('a fresh retrieval after the change is cached again', async () => {
    const timelineId = freshTimeline();
    const variable = makeVariable(timelineId, 'Rope', 3);
    await retrieve(timelineId);
    setVariableField(variable.id, 'value', 1, { timelineId });
    expect(getLastVariableContext(timelineId)).toBeNull();

    await retrieve(timelineId);

    // Dropping is not disabling — the drawer has to come back to life.
    expect(getLastVariableContext(timelineId).listed[0].variable.value).toBe(1);
});
